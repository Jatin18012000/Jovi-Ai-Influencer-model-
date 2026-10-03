<visual_identity>
{{visual_identity}}
</visual_identity>

<storyboard_json>
{{storyboard_json}}
</storyboard_json>

<instructions>
Write production-ready generation prompts for every storyboard scene (same sceneId).

- imagePrompt: a single still frame — subject, action, setting, wardrobe, camera/lens, framing, lighting, mood, style.
- videoPrompt: the same scene in motion — movement, camera motion, pacing, duration feel.
- Describe {{creator_name}} only through the storyboard and the visual identity above. A canonical character block will be prepended automatically; do not describe her face beyond locked anchors.
- Never name, reference or imitate real people, celebrities, brands' spokespeople, or "lookalikes".
- negativePrompt: leave it empty. The system sets a fixed negative prompt; model-written negatives are ignored.
- environmentConsistency / wardrobeConsistency state what must stay identical to neighbouring scenes.
</instructions>

<output_shape>
{"globalStyle":"",
 "prompts":[{"sceneId":"sc1","imagePrompt":"","videoPrompt":"","negativePrompt":"","environmentConsistency":"","wardrobeConsistency":"","cameraSpecification":"","lightingSpecification":""}]}
</output_shape>

Return only the JSON object.
