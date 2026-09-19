// Instructions sent when the user presses Solve. Kept separate so it is easy to tune.
const SOLVE_INSTRUCTIONS =
  "Find the question, problem, or task on my screen and solve it.\n" +
  "- Put the final answer first, clearly marked, then the key steps that get there.\n" +
  "- Multiple choice: name the correct option and say briefly why the others are wrong.\n" +
  "- Coding problem: give complete, working code in the language shown, then its time and space complexity.\n" +
  "- Math or logic: show the working compactly and check the result.\n" +
  "- If several questions are visible, solve the one that looks active or most prominent and say which you picked.\n" +
  "- If no question is visible, say so in one line and describe what you do see.";

// Pressing Solve again is a request for another way in, not for the same answer
// a second time. Every earlier solution is still in the conversation, so the
// model can see exactly what it has to get away from.
const ANOTHER_APPROACH =
  "You already solved this above. I pressed Solve again because I want a different solution.\n" +
  "- Use an approach none of your earlier answers used: a different algorithm, data structure or framing. Not the same one reworded, renamed or micro-optimised.\n" +
  "- It still has to be correct and complete. Do not make it worse just to make it different.\n" +
  "- Open with one line saying how this one differs from the last and what it trades off.\n" +
  "- If the problem genuinely admits no other sensible approach, say so in one line, give the strongest version of it, and say briefly why the alternatives lose.";

function buildSolvePrompt(extra, attempt = 0) {
  const parts = [SOLVE_INSTRUCTIONS];
  if (attempt > 0) parts.push(ANOTHER_APPROACH);
  const note = (extra || "").trim();
  if (note) parts.push(`Extra context from me: ${note}`);
  return parts.join("\n\n");
}

// How many solves this conversation already holds. Counted from the history
// itself rather than kept as state, so it needs no resetting: a new
// conversation starts over at zero, and trimmed-away turns stop counting.
function countSolveTurns(messages) {
  return messages.filter(
    (m) =>
      m.role === "user" &&
      Array.isArray(m.content) &&
      m.content.some((c) => c.type === "text" && c.text.startsWith(SOLVE_INSTRUCTIONS))
  ).length;
}

module.exports = { buildSolvePrompt, countSolveTurns, SOLVE_INSTRUCTIONS, ANOTHER_APPROACH };
