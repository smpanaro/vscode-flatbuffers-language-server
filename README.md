# vscode-flatbuffers-language-server

![VSCode Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/smpanaro.flatbuffers-language-server?label=vscode%20marketplace)


[VSCode](https://code.visualstudio.com) editor extension to add language server features for [FlatBuffers](https://flatbuffers.dev). Powered by [flatbuffers-language-server](https://github.com/smpanaro/flatbuffers-language-server).

<img width="1028" alt="screenshot of a flatbuffer file in vscode" src="https://github.com/smpanaro/vscode-flatbuffers-language-server/raw/HEAD/images/hover.png" />

## Features

- Hover to see type definitions and comments.
- Click to go to definition or see references.
- Completions for types and keywords.
- Real `flatc` errors and warnings in your editor.
- Quick fixes for some errors.
- Rename custom types across files.

## Install

On the [VSCode Marketplace](https://marketplace.visualstudio.com/items?itemName=smpanaro.flatbuffers-language-server).

## Requirements

You'll need to install a separate extension for FlatBuffers syntax highlighting. [This one](https://marketplace.visualstudio.com/items?itemName=floxay.vscode-flatbuffers) works.

## Extension Settings

You can configure how the extension finds the language server binary.

* `flatbuffers.languageServer.autoDownload`: Have the extension automatically download updates to the language server. (Default: false)
* `flatbuffers.languageServer.path`: Specify a path to the language server binary. When unset, the extension will search for a binary in your PATH before offering to download one.
    * You can download a pre-compiled binary [here](https://github.com/smpanaro/flatbuffers-language-server/releases) or [build from source](https://github.com/smpanaro/flatbuffers-language-server).

## Release Notes

Most of the extension functionality comes from the [language server](https://github.com/smpanaro/flatbuffers-language-server). These release notes cover VSCode-specfic configurations.

### 0.0.1

Initial release:
- Configure a language server binary path
- Option to have the extension download a binary
- Option to have the extension keep the binary up to date
