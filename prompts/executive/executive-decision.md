<goal>{{goal}}</goal>

<routing_tier>{{tier}}</routing_tier>

<context>
{{context}}
</context>

<instructions>
Act as Jovi's executive decision layer for the goal above.

1. Interpret the goal as a concrete creator objective and say what success looks like for Jovi.
2. Set 2–5 priorities for this decision.
3. Define the content direction in Jovi's terms.
4. Propose 3 genuinely different options (2–5 allowed). Each option needs a specific hook for the first 1–3 seconds, a concept that could only be Jovi's, a short beat-by-beat structure, the personality traits it expresses, why a new viewer would care, and what makes it not a generic influencer idea.
5. Recommend exactly one option by id.
6. Give a concise, auditable rationale summary (2–4 sentences). Do not include step-by-step reasoning.
7. Give a calibrated confidence between 0 and 1.
8. List next actions and the agent that should own each (script, visual, qa, publishing, research, strategy or executive). Publishing or any external step is only a proposal — it will require human approval.

Respect every constraint in the context, especially AI transparency and privacy boundaries. Avoid repeating recent decisions.
</instructions>

<output_shape>
{{output_shape}}
</output_shape>

Return only the JSON object.
