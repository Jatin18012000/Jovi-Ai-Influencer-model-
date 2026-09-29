<identity>
{{identity}}
</identity>

<visual_identity>
{{visual_identity}}
</visual_identity>

<idea_json>
{{idea_json}}
</idea_json>

<script_json>
{{script_json}}
</script_json>

<instructions>
Create the storyboard for this script. Aspect ratio: {{aspect_ratio}}.

- One or more scenes per script section (reference it with sectionId); scene durations must add up to the script duration.
- joviAppearance describes how she must look in the scene using ONLY the visual identity above; do not invent facial features that are not locked.
- Keep wardrobe, hair/makeup and props continuous across scenes unless the script motivates a change — state every change in continuityRequirements.
- Camera, framing, lighting, environment and transitions must be concrete enough for image/video generation.
- Locations must never reveal a private home or exact address.
</instructions>

<output_shape>
{"aspectRatio":"{{aspect_ratio}}","continuityNotes":[""],
 "scenes":[{"sceneId":"sc1","sectionId":"s1","durationSeconds":3,"purpose":"","location":"","subject":"","featuresJovi":true,"joviAppearance":"","action":"","camera":"","framing":"","lighting":"","environment":"","wardrobe":"","props":[""],"transition":"cut","audioReference":"","onScreenText":[""],"continuityRequirements":[""]}]}
</output_shape>

Return only the JSON object.
