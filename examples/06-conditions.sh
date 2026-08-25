#!/bin/bash
# Conditions et case : prise de décision
score=75

if [ "$score" -ge 90 ]; then
  mention="Excellent"
elif [ "$score" -ge 70 ]; then
  mention="Bien"
else
  mention="À revoir"
fi
echo "Mention : $mention"

# case
jour="mardi"
case "$jour" in
  lundi|mardi|mercredi|jeudi|vendredi) type="jour de semaine" ;;
  samedi|dimanche) type="week-end" ;;
  *) type="inconnu" ;;
esac
echo "$jour est un $type"
