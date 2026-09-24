// PC(Windows) 앱: 로딩 화면을 띄운 뒤 배포된 게임 사이트를 연다.
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

const GAME_HOST = 'yangsechan.onrender.com';

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 380,
    minHeight: 600,
    title: '양세찬 게임',
    backgroundColor: '#101322',
    autoHideMenuBar: true,
  });
  win.loadFile(path.join(__dirname, 'www', 'index.html'));

  // 게임 사이트 밖의 링크는 기본 브라우저로 연다.
  const external = url => { try { return new URL(url).host !== GAME_HOST && !url.startsWith('file:'); } catch { return true; } };
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (external(url)) { e.preventDefault(); shell.openExternal(url); } });
  // 사이트가 제목을 바꿔도 창 제목은 유지
  win.on('page-title-updated', e => e.preventDefault());
}

// 같은 PC에서 여러 창으로 테스트할 수 있도록 단일 인스턴스 제한은 걸지 않음
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
