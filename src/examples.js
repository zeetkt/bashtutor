import ex01 from "../examples/01-somme.sh?raw";
import ex02 from "../examples/02-tableaux.sh?raw";
import ex03 from "../examples/03-associatifs.sh?raw";
import ex04 from "../examples/04-fonctions.sh?raw";
import ex05 from "../examples/05-pipelines.sh?raw";
import ex06 from "../examples/06-conditions.sh?raw";

export const EXAMPLES = [
  { name: "Boucle for — somme 1..n", code: ex01 },
  { name: "Tableaux indexés", code: ex02 },
  { name: "Tableaux associatifs", code: ex03 },
  { name: "Fonctions", code: ex04 },
  { name: "Pipelines — fréquence des mots", code: ex05 },
  { name: "Conditions et case", code: ex06 },
];
