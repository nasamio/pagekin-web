import { createElectronShimModule } from './electron-shim'

const mod = createElectronShimModule()

export const app = mod.app
export const ipcMain = mod.ipcMain
export const safeStorage = mod.safeStorage
export const nativeImage = mod.nativeImage
export const dialog = mod.dialog
export const BrowserWindow = mod.BrowserWindow
export const Notification = mod.Notification
export const shell = mod.shell
export default mod
