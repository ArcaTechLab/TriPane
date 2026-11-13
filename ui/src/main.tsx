import { render } from 'preact';
import { App } from './App';
import { DevToolsWindow } from './DevToolsWindow';
import { guardBrowserShortcuts } from './shortcuts';
import './styles.css';

// Chromium's own shortcuts (reload, view source, DevTools on TriPane itself…) don't apply here.
guardBrowserShortcuts(window);

render(
  new URLSearchParams(location.search).get('view') === 'devtools' ? <DevToolsWindow /> : <App />,
  document.getElementById('root')!,
);
