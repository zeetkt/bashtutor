#!/bin/bash
# Tableaux indexés : création, lecture, boucle
fruits=(pomme banane cerise)
fruits+=(kiwi)

echo "Il y a ${#fruits[@]} fruits"
echo "Le premier : ${fruits[0]}"

for fruit in "${fruits[@]}"; do
  echo "  - $fruit"
done

# Remplacer un élément
fruits[1]=mangue
echo "Après remplacement : ${fruits[@]}"
