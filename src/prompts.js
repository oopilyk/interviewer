// Instructions sent when the user presses Solve. Kept separate so it is easy to tune.
const SOLVE_INSTRUCTIONS =
  "Find the question, problem, or task on my screen and solve it.\n" +
  "- Put the final answer first, clearly marked, then the key steps that get there.\n" +
  "- Multiple choice: name the correct option and say briefly why the others are wrong.\n" +
  "- Coding problem: give complete, working code in the language shown, then its time and space complexity.\n" +
  "- Math or logic: show the working compactly and check the result.\n" +
  "- If several questions are visible, solve the one that looks active or most prominent and say which you picked.\n" +
  "- If no question is visible, say so in one line and describe what you do see.";

function buildSolvePrompt(extra) {
  const note = (extra || "").trim();
  return note ? `${SOLVE_INSTRUCTIONS}\n\nExtra context from me: ${note}` : SOLVE_INSTRUCTIONS;
}

module.exports = { buildSolvePrompt, SOLVE_INSTRUCTIONS };
