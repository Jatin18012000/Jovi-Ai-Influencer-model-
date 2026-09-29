<objective>{{objective}}</objective>

<known_pillars>{{known_pillars}}</known_pillars>

<options_json>
{{options_json}}
</options_json>

Evaluate every option above. Return JSON in exactly this shape:

{
  "evaluations": [
    {
      "optionId": "A",
      "scores": { "quality": 1, "brandFit": 1, "objectiveFit": 1, "originality": 1, "audienceFit": 1, "risk": 1, "cost": 1 },
      "strengths": ["short phrase"],
      "concerns": ["short phrase"]
    }
  ],
  "recommendedOptionId": "the id you would choose",
  "summary": "one or two sentences"
}

All scores are integers from 1 to 5.
