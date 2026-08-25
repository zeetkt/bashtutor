#!/bin/bash
# Pipelines : enchaîner des commandes avec |
# Compter les mots d'un texte
texte="le chat dort le chat mange"
echo "$texte" | tr ' ' '\n' | sort | uniq -c | sort -rn
