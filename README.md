# Trajet — appli de trajet temps réel en Suisse

Appli web installable (PWA), pensée pour un Pixel 6a (écran 412 px de large), qui marche sur tout téléphone.

## Ce qu'elle fait

- Départ et arrivée libres partout en Suisse : adresse, arrêt, lieu ou « Ma position » (GPS).
- Teste tous les arrêts à distance de marche (réglable, 10 min par défaut) au départ et à l'arrivée, puis classe les trajets selon les retards en temps réel.
- Écarte les trajets risqués (correspondance trop courte, train très chargé, trop de marche) et explique pourquoi. On peut quand même les choisir.
- Affiche sur quoi repose la décision et de quand datent les données (vert, orange, gris).
- Carte swisstopo avec chaque trajet en couleur et votre position.
- « Quand partir ? » : compare les départs pour arriver avant une heure donnée (le plus tard, le plus court ou le moins chargé).
- Trajets favoris, recalcul automatique chaque minute et quand vous vous déplacez.
- Option voiture avec trafic en direct (clé TomTom gratuite à coller dans Réglages).

## Mettre l'appli en ligne (5 minutes, gratuit)

Le GPS et l'installation sur le téléphone exigent une adresse en `https://`. Le plus simple :

1. Sur un ordinateur, ouvrez https://app.netlify.com/drop
2. Glissez-déposez le dossier `trajet` (décompressé) dans la page.
3. Netlify donne une adresse du type `https://nom-au-hasard.netlify.app`. Créez un compte gratuit pour la garder.

Autre option : GitHub Pages (déposer le dossier dans un dépôt, puis Settings › Pages).

## Installer sur le Pixel 6a

1. Ouvrez l'adresse dans Chrome.
2. Autorisez la localisation quand l'appli la demande.
3. Menu ⋮ › « Ajouter à l'écran d'accueil » › « Installer ». L'appli s'ouvre ensuite en plein écran, comme une appli normale.

## Tester sans réseau

Ajoutez `?demo=1` à l'adresse : l'appli utilise des données de démonstration (trajet Gland → Fourmi).

## Limites connues

- Le GPS n'est lu que quand l'appli est ouverte (limite des applis web).
- Les perturbations annoncées (travaux, interruptions) ne sont pas encore lues : seuls les retards et les suppressions visibles dans les horaires sont pris en compte. Prochaine étape : flux GTFS-RT « Service Alerts » (clé gratuite opentransportdata.swiss).
- Pas de notification push le matin (il faudrait un petit serveur).
- L'affluence est une prévision des CFF, disponible surtout pour les trains.

## Sources des données

- Horaires, retards, arrêts proches : transport.opendata.ch
- Adresses et fond de carte : swisstopo / geo.admin.ch
- Trafic voiture (optionnel) : TomTom Routing API

## Fichiers

- `index.html`, `styles.css`, `app.js` : l'appli (sans dépendance à installer)
- `sw.js`, `manifest.webmanifest`, `icons/` : installation et fonctionnement hors connexion de l'interface
- `vendor/` : Leaflet 1.9.4 (carte)
