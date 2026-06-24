# TOTEM NIGHT — Direzione di branding (da @edenjoinus)

> Derivata dall'identità di **Eden Eventi** (Instagram @edenjoinus). I valori colore sono **stimati dal profilo/flyer** e vanno confermati con il brand kit ufficiale. **Procurarsi il logo vettoriale (SVG/PNG)** dall'organizzazione per la produzione.
>
> ⚠️ **Riferimento di partenza, non definitivo.** Colori e nome verranno probabilmente cambiati: per questo sono tenuti **isolati** (token di tema in `:root` + nome app configurabile) e si modificano senza toccare logica né dati. Ciò che probabilmente resta valido a prescindere dalla palette: il **concept del totem-albero che cresce**, i **livelli**, le **firme di motion** e la struttura per schermata.

## 1. Cosa ho osservato (brand Eden)
- **Nome:** Eden / “Eden Eventi”. **Payoff:** *“con noi, non è solo un sogno.”* → tono **onirico, aspirazionale, notturno**.
- **Emblema:** **albero della vita** bianco, linework organico che riempie un cerchio (rami in alto, radici in basso). È un motivo **totemico/tribale** già pronto.
- **Colori:** gradiente **viola → indaco/blu** su **nero**; testi **bianchi**. Texture **halftone** a pois, finiture distressed.
- **Tipografia (flyer):** display **condensato grassetto maiuscolo** (“HARVEST”) + maiuscoletto **elegante spaziato** (“COSA VI ASPETTA?”).
- **Format:** apericena/eventi (es. **“HARVEST — Apericena a bordo piscina”**). Allineatissimo al nostro aperitivo cenato tribale.

## 2. Concept per l'app
**L'albero della vita di Eden È il totem.** A inizio serata è spoglio e fioco; **a ogni consumazione si illumina e mette rami/foglie**; durante le sessioni di tap **pulsa ed erutta scintille**; a fine serata il totem più “vivo” è quello di chi ha consumato e giocato di più. Direzione visiva: **rituale bioluminescente** — notte profonda, glow viola, scintille d'ambra (il “fuoco tribale”).

**Asset del totem (demo):** per la demo usare un **modello di totem africano** (palo totemico intagliato / maschere impilate) come **placeholder sostituibile**; l'asset definitivo verrà fornito. L'**albero della vita** Eden resta il **marchio/logo**. I livelli (§5) e le firme di motion (§7) valgono per qualunque modello di totem (2D o 3D).

Nome app suggerito: **EDEN · TOTEM** (oppure per-evento, es. *HARVEST · Totem*). Voce dei testi onirica e calda, sulla scia del payoff Eden.

## 3. Palette (token, da confermare)
```
/* Brand Eden (primari) */
--eden-violet:      #7A4DFF;   /* viola principale (parte alta del gradiente: #A78BFA) */
--eden-indigo:      #4F46E5;   /* fine gradiente, blu-indaco */
--eden-lavender:    #A78BFA;   /* highlight chiaro */

/* Notte (sfondi) */
--night-900:        #0A0A12;   /* sfondo base, nero con tinta viola */
--night-800:        #14111F;   /* superfici elevate / card */
--night-700:        #1E1A2E;   /* bordi / divisori */

/* Testo */
--ink-0:            #FFFFFF;
--ink-300:          #C9C4DB;   /* testo secondario */

/* Accento tribale (fuoco) — aggiunta per il tema, fa contrasto col viola */
--ember:            #FF7A3C;   /* CTA, momenti “vinci”, scintille tap */
--gold:             #F5C451;   /* ticket / premi / vincitore */
--success:          #34D399;
--danger:           #FB7185;

/* Gradiente totem (come il logo) */
--totem-grad: radial-gradient(circle at 50% 35%, #A78BFA 0%, #7A4DFF 45%, #4F46E5 100%);
```
Regola: **viola = brand & atmosfera**, **ambra/oro = energia e ricompensa** (ticket, frenesia tap, reveal vincitore). Non abusare dell'oro: solo sui momenti-premio.

## 4. Tipografia
- **Display / titoli d'impatto** (countdown, “FRENESIA!”, nomi sezione): font condensato grassetto maiuscolo — *Anton* o *Bebas Neue*.
- **Rituale / accenti spaziati** (tagline, livelli totem, “COSA VI ASPETTA?”): *Cinzel* (inciso, tribale) o maiuscoletto molto spaziato.
- **UI / corpo** (saldi, menù, dashboard): *Space Grotesk* o *Sora* (geometrico, leggibile, non generico).
- Scala con almeno 4 livelli; un titolo deve sembrare “troppo grande” (l'ancora visiva).

## 5. Totem: livelli (mappa su `livello_totem` 0–6)
| Livello | Consumazioni | Stato visivo |
|---|---|---|
| 0 | 0 | albero spoglio, glow tenue, quasi spento |
| 1–2 | 1–4 | primi rami illuminati, leggera aura viola |
| 3 | 5–7 | chioma a metà, pulsazione lenta |
| 4 | 8–11 | albero pieno, aura intensa |
| 5 | 12–19 | scintille d'ambra ai rami |
| 6 | 20+ | totem “in fiamme” viola-oro, particellare continuo |

Durante una **sessione di tap**: shake + burst di scintille ambra a ogni tocco, l'aura si gonfia col ritmo dei tap; alla chiusura, “assorbimento” della luce nei ticket.

## 6. Texture & motivi
Halftone a pois (come i flyer), anelli tribali concentrici, il linework dell'albero come ornamento di sfondo a bassissima opacità, grana sottile sul nero. Vetro/blur leggero sui pannelli (saldi, stats).

## 7. Motion signature (3–4 firme ricorrenti)
1. **Ignite** — un ramo/segmento che si accende quando arriva una consumazione.
2. **Tap burst** — scintille d'ambra + “punch” di scala sul totem a ogni tocco (haptic sul telefono).
3. **Count-up** — i numeri (ticket, saldo) salgono animati, mai a scatto.
4. **Reveal** — pioggia di scintille/embers oro alla proclamazione del vincitore.
Easing morbidi (`cubic-bezier(0.16,1,0.3,1)`), niente `linear`.

## 8. Applicazione per schermata
- **Ospite:** sfondo notte, totem-albero al centro come eroe, pannelli vetro per saldi (Normali/Premium) e ticket; menù con texture halftone; arena tap a tutto schermo con countdown grande.
- **Cassa:** sobria e ad alto contrasto (ambienti bui), pulsanti grandi, conferma “tap-to-pay” con ignite del totem dell'ospite.
- **Regia:** dark dashboard, accenti viola, classifica tap live con barre che “bruciano” d'ambra; reveal estrazione scenografico.

## 9. Da procurarsi / confermare
- **Logo ufficiale** Eden (SVG/PNG, versioni mono e a colori).
- **Hex esatti** del brand kit (i valori qui sono stimati dallo schermo).
- Eventuale **font ufficiale** dei flyer (qui ho proposto equivalenti Google Fonts liberi).
- Nome definitivo dell'app (Eden · Totem o per-evento).

> Nota per Claude Code: centralizzare questi token in `:root` / un file `theme`. Lo stile è uno strato sopra la logica già definita nello schema — non cambia dati né regole.
