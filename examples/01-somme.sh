#!/bin/bash
# Somme des nombres de 1 à n avec une boucle for
n=5
somme=0

for i in $(seq 1 $n); do
  somme=$((somme + i))
  echo "après l'itération $i, somme = $somme"
done

echo "Résultat final : $somme"
