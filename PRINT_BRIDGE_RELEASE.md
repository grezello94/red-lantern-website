# Print Bridge release and signing

The Operations setup screen serves lightweight setup bundles now. The commands below create production native installers when released from the matching operating system.

The repository also includes a manual GitHub Actions workflow, **Print Bridge installers**. It uses clean Windows and macOS runners with Node.js 22 and uploads both native installer artefacts. Enable signing only after the relevant credentials are stored as protected CI secrets.

## CI secrets

The workflow is intentionally usable without secrets for internal testing. For trusted production releases, add these **GitHub Actions secrets** (never repository files):

| Platform | Secret | Purpose |
| --- | --- | --- |
| Windows | `WINDOWS_CERTIFICATE_P12_BASE64` | Base64 of the organisation code-signing PFX/P12. |
| Windows | `WINDOWS_CERTIFICATE_PASSWORD` | Password for that certificate. |
| macOS | `MAC_INSTALLER_CERTIFICATE_P12_BASE64` | Base64 of the Developer ID Installer P12. |
| macOS | `MAC_INSTALLER_CERTIFICATE_PASSWORD` | Password for that certificate export. |
| macOS | `MAC_KEYCHAIN_PASSWORD` | Newly generated temporary CI keychain password. |
| macOS | `MAC_INSTALLER_IDENTITY` | Exact `Developer ID Installer: …` identity shown by Keychain Access. |
| macOS | `APPLE_NOTARY_API_KEY_BASE64` | Base64 of an App Store Connect API key `.p8` file. |
| macOS | `APPLE_NOTARY_KEY_ID` | App Store Connect API key ID. |
| macOS | `APPLE_NOTARY_ISSUER_ID` | App Store Connect issuer ID. |

When the Windows certificate is hardware-backed or cloud-managed rather than exportable as P12, replace the Windows signing step with that provider’s secure CI signing action; do not export a protected private key merely to fit this workflow.

## Windows

1. Install Inno Setup 6 on a Windows release machine.
2. Run `npm run package:bridge:windows`.
3. The result is `releases/Red-Lantern-Print-Bridge-Windows-Setup.exe`. It includes the Node.js 22 runtime used by the Bridge.
4. Sign it in CI by setting `WINDOWS_SIGN_COMMAND`. The command must contain `{file}`, which the build replaces with the installer path.

Use a public organisation code-signing certificate (preferably EV) from a recognised certificate authority. Store its access token or hardware-backed signing configuration only in CI secrets.

## macOS

1. Install Xcode Command Line Tools on a Mac release machine.
2. Run `npm run package:bridge:macos`.
3. Set `MAC_INSTALLER_IDENTITY` to the exact `Developer ID Installer: …` identity to sign the package.
4. Optionally set `APPLE_NOTARY_PROFILE` to a `notarytool` keychain profile. The build then submits and staples the notarization ticket automatically. The package includes the Node.js 22 runtime used by the Bridge.

The result is `releases/Red-Lantern-Print-Bridge-macOS.pkg`.

## Required accounts

- Windows: public organisation code-signing certificate. Do not commit certificate files or passwords.
- macOS: Apple Developer Program membership, `Developer ID Application` and `Developer ID Installer` certificates, and a notarytool authentication profile.

Publish only signed release artefacts. Until signing credentials are present, the web screen intentionally distributes the transparent ZIP setup bundle rather than pretending it is a trusted native installer.
