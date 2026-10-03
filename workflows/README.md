# ComfyUI Workflows: Review and Pinning

No workflow is committed yet (audit D-22 / F-20). The identity-conditioned image workflow (IP-Adapter, PuLID or similar) and the video workflow are the owner's choice. They live in ComfyUI on the owner's machine and have not been exported here, so they could not be reviewed or tested.

Jovi does **not** ship a sample workflow: an untested one would be a fake integration.

## To commit a workflow for review

1. In ComfyUI, build and test the workflow, then export it with **Save (API Format)**.
2. Replace the inputs with Jovi's placeholders:
   - **Required:** `{{POSITIVE_PROMPT}}`.
   - **Usual:** `{{NEGATIVE_PROMPT}}`, `{{WIDTH}}`, `{{HEIGHT}}`, `{{SEED}}`, `{{FILENAME_PREFIX}}`.
   - **Identity conditioning (image):** `{{REFERENCE_IMAGE}}`. This is filled with an uploaded file from `JOVI_REFERENCE_DIR`.
   - **Video:** `{{DURATION_SECONDS}}`, `{{FRAMES}}`, `{{FPS}}`, and optionally `{{SOURCE_IMAGE}}` for image-to-video.
3. Save it as `workflows/jovi-image.json` or `workflows/jovi-video.json` and open a pull request.
4. **Review checklist:**
   - Every node `class_type` is from ComfyUI core or a custom node you have reviewed and pinned to a version.
   - There are no nodes that run code, shell commands or network requests (for example script, exec or HTTP nodes).
   - The checkpoint, LoRA and IP-Adapter models are licensed for commercial use and are not trained on a real person's likeness.
   - Output nodes write only images or video (SaveImage, or a video combine node).
   - Placeholders appear only in string or number inputs, never as node keys.
5. **After merge, pin it** (see `docs/security/trust-model.md`):

   ```bash
   shasum -a 256 workflows/jovi-image.json   # → COMFYUI_IMAGE_WORKFLOW_SHA256
   ```

6. Point `COMFYUI_IMAGE_WORKFLOW` / `COMFYUI_VIDEO_WORKFLOW` at the files and check with `npm run jovi:providers`.
