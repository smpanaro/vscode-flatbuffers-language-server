import axios from "axios";
import path from "path";
import fs from "fs-extra";
import { commands, ConfigurationTarget, ExtensionContext, FileChangeType, FileSystemWatcher, ProgressLocation, RelativePattern, Uri, window, workspace } from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  Disposable,
  URI,
} from "vscode-languageclient/node";
import which from "which";
import { pipeline } from "stream/promises";
import * as tar from "tar";
import extract from "extract-zip";

// GitHub Downloader/Paths
const GITHUB_REPO = 'smpanaro/flatbuffers-language-server';
const BINARY_NAME = 'flatbuffers-language-server';
const VERSION_PREFIX = 'flatbuffers-language-server-';

// Persistent State
const LATEST_VERSION_KEY = 'latestKnownVersion';
const LATEST_SKIPPED_VERSION_KEY = 'latestSkippedVersion';

// Settings
const CONFIG_NAME = 'flatbuffers';
const AUTO_DOWNLOAD_CONFIG = 'languageServer.autoDownload';
const PATH_CONFIG = 'languageServer.path';

let client: LanguageClient;
let fileSystemWatcher: FileSystemWatcher;
let settingsWatcher: Disposable;

export async function activate(context: ExtensionContext) {
  const serverPath = await getLanguageServerPath(context);

  // Prompt to reload when settings change.
  registerSettingsWatcher(context);

  if (!serverPath) {
    const openSettings = "Configure";
    const result = await window.showErrorMessage(
      'Could not find or download the FlatBuffers language server. Please configure a binary in settings.',
      openSettings,
    );
    if (result === openSettings) {
      await commands.executeCommand('workbench.action.openSettings', CONFIG_NAME);
    }
    return;
  }

  const serverArgs: string[] = [];
  const serverOptions: ServerOptions = {
    command: serverPath,
    args: serverArgs,
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "flatbuffers" }],
  };

  client = new LanguageClient(
    "flatbuffers-language-server",
    "FlatBuffers Language Server",
    serverOptions,
    clientOptions,
  );

  // Renames of parent directories are not reported by VSCode.
  // https://github.com/microsoft/vscode/issues/60813
  supplementFileNotifications(client);

  // This also launches the server.
  client.start();
}

export function deactivate(): Thenable<void> | undefined {
  if (fileSystemWatcher) {
    fileSystemWatcher.dispose();
  }
  if (settingsWatcher) {
    settingsWatcher.dispose();
  }
  if (!client) {
    return undefined;
  }
  return client.stop();
}

function supplementFileNotifications(client: LanguageClient) {
  fileSystemWatcher = workspace.createFileSystemWatcher('**/*');
  fileSystemWatcher.onDidChange((u) => onFileEvent(u, FileChangeType.Changed));
  fileSystemWatcher.onDidCreate((u) => onFileEvent(u, FileChangeType.Created));
  fileSystemWatcher.onDidDelete((u) => onFileEvent(u, FileChangeType.Deleted));
}

const IGNORED_PATH_SEGMENTS = new Set([
  '.git', '.svn', '.hg', '.bzr', 'node_modules', 'bower_components', '.idea', '.vscode', 'venv', '.venv', 'dist', 'build', '.cache', '__pycache__', '.pytest_cache']
);

async function onFileEvent(uri: Uri, type: FileChangeType) {
  // console.log(`File ${FileChangeType[type].toLowerCase()}: ${uri.fsPath}`);

  // We can't watch only directories that contain .fbs files.
  // We also can't exclude specific directories from the glob.
  // So short-circuit here in an attempt to limit unnecessary work.
  // TODO: Could source this list from .gitignore ala ripgrep.
  const isIgnored = uri.fsPath.split(path.sep).reverse().some((part) => {
    return IGNORED_PATH_SEGMENTS.has(part);
  });

  if (isIgnored) {
    return;
  }

  if (type === FileChangeType.Deleted) {
    if (path.extname(uri.fsPath) === "") {
      // Can't discover files for deletes, so send the directory.
      client.sendNotification('workspace/didChangeWatchedFiles', {
        changes: [{ uri: uri.toString(), type }],
      }).catch((err) => {
        console.error("Error sending didChangeWatchedFiles for delete", err);
      });
    }

    return;
  }

  const isDirectory = await fs.stat(uri.fsPath)
    .then(s => s.isDirectory())
    .catch(() => false);

  if (!isDirectory) {
    return;
  }

  const files = await getAllUrisInDir(uri);
  if (files.length) {
    // console.log(`Expanded to:\n${files.join("\n")}`);
    client.sendNotification('workspace/didChangeWatchedFiles', {
      changes: files.map((u) => ({ uri: u.toString(), type })),
    }).catch((err) => {
      console.error("Error sending didChangeWatchedFiles for dir", err);
    });
  }
}

async function getAllUrisInDir(dir: Uri) {
  const pattern = new RelativePattern(dir, '**/*.fbs');
  const uris = await workspace.findFiles(pattern);
  return uris;
}

function registerSettingsWatcher(context: ExtensionContext) {
  settingsWatcher = workspace.onDidChangeConfiguration(e => {
    // Check if any of our extension's settings were changed
    const affectsPath = e.affectsConfiguration(`${CONFIG_NAME}.${PATH_CONFIG}`);
    const affectsAutoDownload = e.affectsConfiguration(`${CONFIG_NAME}.${AUTO_DOWNLOAD_CONFIG}`);

    if (affectsPath || affectsAutoDownload) {
      const reloadOption = "Reload Window";
      window.showInformationMessage(
        'FlatBuffers configuration has changed. Please reload for the changes to take effect.',
        reloadOption
      ).then(selection => {
        if (selection === reloadOption) {
          commands.executeCommand('workbench.action.reloadWindow');
        }
      });
    }
  });

  context.subscriptions.push(settingsWatcher);
}

/**
 * Tries to find the language server binary path in this order:
 * 1. User configuration
 * 2. System PATH
 * 3. Downloads from GitHub
 */
async function getLanguageServerPath(context: ExtensionContext): Promise<string | null> {
  const config = workspace.getConfiguration(CONFIG_NAME);
  const userDefinedPath = config.get<string | null>(PATH_CONFIG, null);
  if (userDefinedPath) {
    console.log(`Using user-defined path: ${userDefinedPath}`);
    return userDefinedPath;
  }

  try {
    const pathFromWhich = await which(BINARY_NAME);
    console.log(`Found binary in PATH: ${pathFromWhich}`);
    return pathFromWhich;
  } catch (err) {
    // Not found in PATH, continue to next step
  }

  // Download from GitHub
  const shouldAutoDownload = config.get<boolean>(AUTO_DOWNLOAD_CONFIG, false);
  const storagePath = context.globalStorageUri.fsPath;
  const cachedVersion = context.globalState.get<string>(LATEST_VERSION_KEY);

  // Use a previously downloaded version.
  if (cachedVersion) {
    const versionDir = path.join(storagePath, `${VERSION_PREFIX}${cachedVersion}`);
    const binaryName = BINARY_NAME + (process.platform === 'win32' ? '.exe' : '');
    const binaryPath = path.join(versionDir, binaryName);

    if (await fs.pathExists(binaryPath)) {
      console.log(`Using cached language server version ${cachedVersion} from ${binaryPath}`);
      // Start a non-blocking check for new versions in the background.
      checkForUpdatesInBackground(context, cachedVersion, shouldAutoDownload);
      return binaryPath;
    }
  }

  // Initial download.
  if (shouldAutoDownload) {
    console.log('Binary not found. Auto-downloading from GitHub based on user setting.');
    return await downloadLanguageServer(context);
  } else {
    const downloadAndEnableOption = "Download & Auto-Update";
    const downloadOnceOption = "Download Once";

    const result = await window.showInformationMessage(
      'FlatBuffers language server was not found. Download it?',
      { modal: false },
      downloadAndEnableOption,
      downloadOnceOption
    );

    if (result === downloadAndEnableOption) {
      await enableAutoUpdates();
      return await downloadLanguageServer(context);

    } else if (result === downloadOnceOption) {
      return await downloadLanguageServer(context);

    } else {
      // User cancelled the prompt (by closing it or pressing Escape).
      // No need to show a message, the catch-all will show.
      return null;
    }
  }
}

/**
 * Determines the asset name for the current platform.
 */
function getAssetName(version: string): string | null {
  let os: string;
  let arch: string;

  switch (process.platform) {
    case 'darwin':
      os = 'apple-darwin';
      break;
    case 'linux':
      os = 'unknown-linux-gnu';
      break;
    case 'win32':
      os = 'pc-windows-msvc';
      break;
    default:
      return null; // Unsupported OS
  }

  switch (process.arch) {
    case 'x64':
      arch = 'x86_64';
      break;
    case 'arm64':
      arch = 'aarch64';
      break;
    default:
      return null; // Unsupported architecture
  }

  const extension = process.platform === 'win32' ? 'zip' : 'tar.gz';
  return `${BINARY_NAME}-${version}-${arch}-${os}.${extension}`;
}

/**
 * Silently checks for new releases in the background and prompts the user to update if one is found.
 * @param context The extension context for storage.
 * @param cachedVersion The currently installed version string.
 * @param shouldAutoDownload Whether to auto-download updates without prompting.
 */
async function checkForUpdatesInBackground(context: ExtensionContext, cachedVersion: string, shouldAutoDownload: boolean) {
  console.log(`Checking for updates. Current version: ${cachedVersion}`);
  try {
    const { latestVersion } = await getLatestRelease();
    const skippedVersion = context.globalState.get<string>(LATEST_SKIPPED_VERSION_KEY, "");

    if (latestVersion !== cachedVersion) {
      console.log(`New version found: ${latestVersion}`);
      if (shouldAutoDownload) {
        await downloadLanguageServer(context, true);
      } else if (latestVersion === skippedVersion) {
        console.log(`Latest version was skipped (${latestVersion}).`);
      } else {
        const updateOption = "Download";
        const enableUpdatesOption = "Download & Auto-Update";
        const skipThisVersionOption = "Skip This Version";
        const result = await window.showInformationMessage(
          `A new version of the FlatBuffers language server is available. [Release Notes](https://github.com/smpanaro/flatbuffers-language-server/releases)`,
          updateOption,
          enableUpdatesOption,
          skipThisVersionOption,
        );

        if (result === enableUpdatesOption) {
          await enableAutoUpdates();
          await downloadLanguageServer(context, true);
        } else if (result === updateOption) {
          await downloadLanguageServer(context, true);
        } else if (result === skipThisVersionOption) {
          await context.globalState.update(LATEST_SKIPPED_VERSION_KEY, latestVersion);
          console.log(`Setting skipped version to ${latestVersion}.`);
        }
      }
    } else {
      console.log('Language server is up to date.');
    }
  } catch (error) {
    console.error("Failed to check for updates in the background:", error);
    // Fail silently, as this is a background task.
  }
}

/**
 * Downloads and manages the language server from GitHub releases.
 */
async function downloadLanguageServer(context: ExtensionContext, isUpdate: boolean = false): Promise<string | null> {
  const storagePath = context.globalStorageUri.fsPath;
  await fs.ensureDir(storagePath);

  try {
    const { latestVersion, assets } = await getLatestRelease();

    // Determine paths and check if the binary already exists
    const versionDir = path.join(storagePath, `${VERSION_PREFIX}${latestVersion}`);
    const binaryName = BINARY_NAME + (process.platform === 'win32' ? '.exe' : '');
    const binaryPath = path.join(versionDir, binaryName);

    if (await fs.pathExists(binaryPath)) {
      console.log(`Binary for version ${latestVersion} already exists at ${binaryPath}`);
      if (process.platform !== 'win32') {
        await fs.chmod(binaryPath, 0o755); // executable
      }
      cleanupOldVersions(storagePath, `${VERSION_PREFIX}${latestVersion}`);
      return binaryPath;
    }

    // Find the correct asset for the platform
    const assetName = getAssetName(latestVersion);
    if (!assetName) {
      window.showErrorMessage(`Unsupported platform: ${process.platform}-${process.arch}`);
      return null;
    }
    const matchingAsset = assets.find((asset: any) => asset.name === assetName);
    if (!matchingAsset) {
      throw new Error(`Could not find a release asset for your platform: ${assetName}`);
    }

    // Download and extract the new version
    const downloadedPath = await window.withProgress({
      location: ProgressLocation.Window,
      title: `${isUpdate ? "Updating" : "Downloading"} FlatBuffers Language Server`,
      cancellable: false
    }, async (progress) => {
      progress.report({ message: `Fetching v${latestVersion}…` });

      const downloadUrl = matchingAsset.browser_download_url;
      const tempArchivePath = path.join(storagePath, assetName);

      const downloadStream = await axios({
        url: downloadUrl,
        method: 'GET',
        responseType: 'stream',
      });
      await pipeline(downloadStream.data, fs.createWriteStream(tempArchivePath));

      progress.report({ message: 'Extracting…' });
      await fs.ensureDir(versionDir);

      if (assetName.endsWith('.zip')) {
        await extract(tempArchivePath, { dir: versionDir });
      } else {
        await tar.x({ file: tempArchivePath, cwd: versionDir });
      }

      await fs.remove(tempArchivePath); // Clean up the downloaded archive

      return binaryPath;
    });

    if (process.platform !== 'win32') {
      await fs.chmod(downloadedPath, 0o755);
    }

    await context.globalState.update(LATEST_VERSION_KEY, latestVersion);

    if (isUpdate) {
      const reloadOption = "Reload Now";
      const result = await window.showInformationMessage(
        `Updated FlatBuffers Language Server. Reload to use the latest version (v${latestVersion}).`,
        reloadOption
      );
      if (result === reloadOption) {
        commands.executeCommand('workbench.action.reloadWindow');
      }
    } else {
      const revealUri = `command:revealFileInOS?${encodeURIComponent(JSON.stringify([Uri.file(versionDir)]))}`;
      window.showInformationMessage(`Successfully downloaded FlatBuffers Language Server v${latestVersion} to the [extension's directory](${revealUri}).`);
    }

    await cleanupOldVersions(storagePath, `${VERSION_PREFIX}${latestVersion}`);

    return downloadedPath;
  } catch (error: any) {
    const msg = error?.message || error;
    window.showErrorMessage(`Failed to ${isUpdate ? "update" : "download"} language server: ${msg}`);
    return null;
  }
}

async function getLatestRelease() {
  const releaseUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
  // For testing pre-release:
  // const releaseUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/255561479`;

  const releaseResponse = await axios.get(releaseUrl, {
    headers: { 'Accept': 'application/vnd.github.v3+json' },
    timeout: 15000, // Avoid hanging on slow connections.
  });
  const latestVersion = releaseResponse.data.tag_name;
  const assets = releaseResponse.data.assets;
  return { latestVersion, assets };
}

/**
 * Removes old, obsolete versions of the language server.
 */
async function cleanupOldVersions(storagePath: string, currentVersionDir: string): Promise<void> {
  try {
    const entries = await fs.readdir(storagePath);
    for (const entry of entries) {
      if (entry.startsWith(VERSION_PREFIX) && entry !== currentVersionDir) {
        console.log(`Removing old version: ${entry}`);
        await fs.remove(path.join(storagePath, entry));
      }
    }
  } catch (error) {
    console.error("Error cleaning up old versions:", error);
  }
}

async function enableAutoUpdates() {
  const config = workspace.getConfiguration(CONFIG_NAME);
  await config.update(AUTO_DOWNLOAD_CONFIG, true, ConfigurationTarget.Global);
  window.showInformationMessage("FlatBuffers auto-update enabled.");
}