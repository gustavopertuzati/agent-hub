@echo off
REM Exposition Ngrok de la passerelle Orkestr (port 4000).
REM Sans --url, ngrok attribue une URL ephemere et l'affiche au demarrage.
REM ATTENTION : ne pas utiliser --pooling-enabled avec l'URL d'un autre
REM service (ex: open-decks) — cela melangerait les trafics.
REM Les collaborateurs doivent envoyer le header :
REM   ngrok-skip-browser-warning: true
REM (page d'avertissement ngrok gratuit, sinon ERR_NGROK_6024).
ngrok http 4000
