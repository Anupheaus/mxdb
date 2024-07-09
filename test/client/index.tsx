import { App } from './App';
import { createRoot } from 'react-dom/client';

function renderApp() {
  const rootElement = document.getElementsByTagName('root')[0];
  const root = createRoot(rootElement);
  root.render(<App />);
}

window.onload = renderApp;
