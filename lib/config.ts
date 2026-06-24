// Configurazione applicativa centralizzata.
// Branding placeholder (vincolo 5): il NOME vive qui, i COLORI in app/globals.css (:root).
// Cambiare brand non deve toccare logica né dati.
export const APP_CONFIG = {
  name: process.env.NEXT_PUBLIC_APP_NAME ?? 'Totem Night',
  description: 'Totem digitale per aperitivo tribale — credito, tap, estrazione.',
  // Colore tema = token --night-900 (tenuto allineato a app/globals.css :root).
  themeColor: '#0a0a12',
} as const;
