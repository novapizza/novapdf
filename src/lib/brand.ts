/**
 * The product name people see. Must equal `productName` in
 * `src-tauri/tauri.conf.json` (brand.test.ts checks), which names the window,
 * the installer and the app bundle.
 *
 * Display only: installs depend on the internal names (app identifier
 * `io.novapdf.app`, the `novapdf.*` storage keys), which must not follow a
 * rename. See README, "Product name and updates".
 */
export const APP_NAME = "NovaQuire";
