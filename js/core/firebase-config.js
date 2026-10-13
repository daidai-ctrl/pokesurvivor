/* ============ firebase-config.js — conexión con tu proyecto de Firebase ============
 * Pega aquí la configuración de tu app web de Firebase (Consola de Firebase >
 * Configuración del proyecto > Tus apps > SDK setup and configuration > Config).
 * Los pasos completos están en docs/FIREBASE.md.
 *
 * Estos datos NO son secretos: Firebase los diseña para ir en la web. Lo que
 * protege las partidas son las reglas de Firestore (firestore.rules).
 *
 * Si se pone a null, el juego funciona en modo local (sólo en el navegador).
 */
// PokéSurvivor's own Firebase project. These Web SDK values are public by
// design; Firestore and Realtime Database rules protect the actual data.
G.FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDG5_k-DmKo4XC__He1ClB8BKp93wZx8q0',
  authDomain: 'pokesurvivor-xyz.firebaseapp.com',
  projectId: 'pokesurvivor-xyz',
  storageBucket: 'pokesurvivor-xyz.firebasestorage.app',
  messagingSenderId: '559114200524',
  appId: '1:559114200524:web:0360256ec6b4dc384be969',
  databaseURL: 'https://pokesurvivor-xyz-default-rtdb.europe-west1.firebasedatabase.app'
};

// Cloudflare data plane. Authentication remains Firebase for now so existing
// accounts keep their uid while Firestore data is migrated safely.
G.FIREBASE_DATA_URL = 'https://api.pokesurvivor.xyz';

// PayPal is intentionally a separate Worker. Keep this empty until the
// Sandbox Worker has a preview URL; an empty value hides the PayPal button so
// a half-configured payment path can never be shown to players.
G.PAYPAL_API_URL = 'https://pokesurvivor-paypal.zzy1848599547.workers.dev';

/* Ejemplo de cómo debe quedar:
G.FIREBASE_CONFIG = {
  apiKey: 'AIza...',
  authDomain: 'tu-proyecto.firebaseapp.com',
  projectId: 'tu-proyecto',
  storageBucket: 'tu-proyecto.firebasestorage.app',
  messagingSenderId: '1234567890',
  appId: '1:1234567890:web:abc123'
};
*/
