#!/bin/bash
# Fonctions : définition, paramètres, valeurs de retour
dire_bonjour() {
  local nom=$1
  echo "Bonjour $nom !"
}

additionner() {
  local a=$1
  local b=$2
  echo $((a + b))
}

dire_bonjour "Alice"
resultat=$(additionner 3 4)
echo "3 + 4 = $resultat"
