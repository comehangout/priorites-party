# Priorités Party — première version multijoueur

Un jeu web inspiré du principe de Priorities : chaque joueur propose un choix, tout le monde classe secrètement les propositions, puis les joueurs tentent de retrouver l'auteur de chaque classement. Une bonne association vaut 1 point pour le joueur qui l'a devinée.

## Fonctionnalités
- Salon avec code à 6 caractères et pseudo sans compte
- Parties à distance ou dans la même pièce (chacun sur son appareil)
- De 1 à 10 manches, choisi à la création
- Propositions individuelles et détection des doublons
- Classement secret par flèches haut/bas
- Révélation automatique quand tout le monde a validé
- Association anonyme, avec chaque joueur utilisable une seule fois
- Score cumulatif et classement final
- Affichage des joueurs déconnectés

## Lancer en local
Prérequis : Node.js 18 ou plus récent.

1. Décompressez l'archive.
2. Dans un terminal, ouvrez le dossier `priorites-party`.
3. Exécutez `npm install`.
4. Exécutez `npm start`.
5. Ouvrez http://localhost:3000 dans votre navigateur.

Pour tester plusieurs joueurs sur un même ordinateur, ouvrez plusieurs fenêtres privées/navigateurs. Pour jouer sur le même réseau Wi-Fi, les autres appareils peuvent utiliser l'adresse IP locale de l'ordinateur qui exécute le serveur, sur le port 3000 (autoriser le port dans le pare-feu si nécessaire).

## Pour jouer à distance
Il faut déployer ce dossier sur un hébergeur compatible Node.js qui prend en charge les connexions WebSocket (Socket.IO), puis partager l'URL et le code du salon. Le site n'est pas encore publié en ligne par cette archive.

## Limites de cette version
- Les salons sont conservés en mémoire : redémarrer le serveur efface les parties.
- Pas de reconnexion à une partie après fermeture du navigateur.
- Un joueur qui quitte une partie en cours reste dans la manche pour éviter de modifier silencieusement les règles; il peut donc bloquer la progression.
- Le score est calculé comme 1 point par bonne association faite par un joueur. Chaque joueur doit associer les classements à des personnes différentes.
- Ce projet est un prototype jouable, pas encore un service de production. Pour une utilisation publique, ajouter persistance, reconnexion sécurisée, validation renforcée et tests.

## Structure
- `server.js` : serveur Express et logique multijoueur Socket.IO
- `public/index.html` : interface responsive
- `package.json` : dépendances et commande de démarrage
