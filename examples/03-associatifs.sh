#!/bin/bash
# Tableaux associatifs (clé -> valeur)
declare -A capitales=([France]=Paris [Espagne]=Madrid [Italie]=Rome)

echo "Capitale de la France : ${capitales[France]}"

# Ajouter une entrée
capitales[Portugal]=Lisbonne

echo "Nombre de pays : ${#capitales[@]}"
for pays in "${!capitales[@]}"; do
  echo "  $pays -> ${capitales[$pays]}"
done
