import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

createApp(App).mount('#app');

// Dev is left alone so HMR is never served from cache; install from `yarn preview` or a deploy.
// Document-relative, not BASE_URL: a deploy mounted on a subpath the build did not know about
// would otherwise ask for /sw.js and be handed the host's HTML fallback.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener(
    'load',
    () => void navigator.serviceWorker.register('./sw.js', { scope: './' }),
  );
}
