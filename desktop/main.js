const { app, BrowserWindow, Menu, shell } = require('electron');

const APP_ORIGIN = 'https://sajilorent.onrender.com';
const APP_URL = APP_ORIGIN + '/login.html?view=app';

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 360,
    minHeight: 600,
    title: 'SajiloRent',
    backgroundColor: '#0b1120',
    autoHideMenuBar: true,
    icon: __dirname + '/icon.png'
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_ORIGIN) && url.startsWith('http')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  win.loadURL(APP_URL);
}

Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});