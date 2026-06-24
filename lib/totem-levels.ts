// Mappa livello_totem (0–6) → presentazione. Componente Totem ISOLATO e SOSTITUIBILE (vincolo 4).
// La soglia numerica è AUTORITATIVA lato DB (funzione totem_level()); qui vive solo la presentazione.
// Demo: modello "totem africano" placeholder — l'asset definitivo verrà fornito.
export type TotemLevel = {
  level: number;
  label: string;
  minConsumazioni: number;
};

export const TOTEM_LEVELS: readonly TotemLevel[] = [
  { level: 0, label: 'Spento', minConsumazioni: 0 },
  { level: 1, label: 'Risveglio', minConsumazioni: 1 },
  { level: 2, label: 'Primi rami', minConsumazioni: 2 },
  { level: 3, label: 'Chioma', minConsumazioni: 5 },
  { level: 4, label: 'Pieno', minConsumazioni: 8 },
  { level: 5, label: 'Scintille', minConsumazioni: 12 },
  { level: 6, label: 'In fiamme', minConsumazioni: 20 },
] as const;
