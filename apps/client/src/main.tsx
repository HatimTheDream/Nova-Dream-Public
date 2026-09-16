import { createRoot } from 'react-dom/client';
import './install';
import '@fontsource-variable/sora';
import { App } from './App';
import './styles.css';
import './theme.css';
import './ui-refinements.css';

createRoot(document.getElementById('root')!).render(<App/>);
