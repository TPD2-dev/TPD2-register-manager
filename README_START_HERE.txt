TUPACKS SPS-530 MANAGER v0.2 — CROSS-PLATFORM
================================================

WHAT THIS IS
This is an installable Progressive Web App (PWA) designed for:
- iPad
- iPhone
- Windows PC
- Mac / other modern browsers

All SPS-530 backup processing happens inside the browser on your device. The app does not send your PLU database to a server.

CURRENT v0.2 SCOPE
ENABLED:
- Open SPS-530 backup ZIP
- Detect one or multiple backup profiles in a ZIP
- Read and search fixed 64-byte PLU records
- Change the description of an existing PLU
- Change the current price of an existing PLU
- Export the product list to CSV
- Generate a separate validated backup ZIP
- Block export if any byte outside the proven description/price fields changes

LOCKED UNTIL CONTROLLED REGISTER TESTS ARE COMPLETED:
- Add PLU
- Delete PLU
- Change barcode
- Change product group
- Change tax/status profile
- Change CRV/deposit behavior
- Create/rename groups

IMPORTANT SAFETY
1. Always open a fresh backup from the exact register you plan to update.
2. Keep an untouched rollback backup somewhere else.
3. Do not overwrite the source ZIP.
4. Extract the app-created ZIP before copying its profile folder to the register USB.
5. After restoring, run PLU Integrity Check and test the edited item plus unrelated items.
6. Do not use this app to alter firmware, memory allocation, payment/EFT configuration, ports, employees, function keys, or gas-system settings.

IPHONE/IPAD INSTALL
A PWA must be served from an HTTPS website before iOS can install it to the Home Screen. See DEPLOY_FREE.txt.
After deployment:
1. Open the website in Safari.
2. Tap Share.
3. Tap Add to Home Screen.
4. Open Tupacks PLU from the Home Screen.
5. Tap Open Backup ZIP and select the ZIP from the Files app.

WINDOWS
After deployment, open the same website in Edge or Chrome. Use the browser's Install App option. The same hosted app can then work offline after its first successful load.
