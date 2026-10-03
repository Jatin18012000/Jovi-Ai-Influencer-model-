/**
 * SIMULATION ONLY — canned, schema-valid planning (Phase 7) and production
 * (Phase 8) responses for the MockProvider. They are derived from the tagged
 * inputs so a simulated run is internally coherent, and every free-text field
 * is visibly marked [SIMULATED]. Never used alongside real providers.
 */

const SIM = '[SIMULATED]';

function tagJson<T>(prompt: string, tag: string): T | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(prompt);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1].replace(/‹/g, '<').replace(/›/g, '>')) as T;
  } catch {
    return null;
  }
}

export function mockPlanning(taskType: string, prompt: string): unknown {
  const goal = /Goal: (.*)/.exec(prompt)?.[1]?.trim() ?? 'Jovi content';
  switch (taskType) {
    case 'planning.research':
      return {
        topic: goal.slice(0, 280),
        findings: [
          { claim: `${SIM} Jovi's audience responds to personality-led city stories.`, evidence: 'knowledge base: content strategy', sourceType: 'KNOWLEDGE_BASE', confidence: 0.7, relevance: 0.9 },
          { claim: `${SIM} Coffee and café culture is a recurring Jovi habit.`, evidence: 'operational memory: habits', sourceType: 'MEMORY', confidence: 0.8, relevance: 0.8 },
          { claim: `${SIM} Short vertical video favours a hook in the first seconds.`, evidence: 'general platform knowledge', sourceType: 'MODEL_KNOWLEDGE', confidence: 0.6, relevance: 0.8 },
        ],
        audienceAngles: [`${SIM} curious newcomers meeting an AI creator`, `${SIM} city-lifestyle fans`],
        risks: [`${SIM} generic café content without personality`],
      };
    case 'planning.trends':
      return {
        trends: [
          { name: 'guess-the-fact formats', signal: `${SIM} evergreen interactive format`, fitScore: 0.8, angle: 'AI-reveal game', freshness: 'EVERGREEN' },
          { name: 'city micro-guides', signal: `${SIM} evergreen`, fitScore: 0.75, angle: 'Jovi rates spots', freshness: 'EVERGREEN' },
          { name: 'creator POV intros', signal: `${SIM} general contemporary format`, fitScore: 0.7, angle: 'first-person intro', freshness: 'CURRENT' },
        ],
        avoid: [`${SIM} copying another creator's signature bit`],
      };
    case 'planning.strategy':
      return {
        objective: `${SIM} Introduce Jovi through personality-first Reels.`,
        corePillars: ['Entertainment & Personality', 'Travel & Exploration'],
        supportingPillars: ['Lifestyle & Everyday Life'],
        formats: [
          { format: 'REEL', role: 'discovery' },
          { format: 'STORY', role: 'community' },
        ],
        cadenceGuideline: '1–2 feed pieces per day plus Stories (guideline)',
        experiments: [`${SIM} AI-reveal hook vs city hook`, `${SIM} question CTA vs choice CTA`],
        guardrails: ['AI transparency', 'privacy boundaries'],
        rationale: `${SIM} canned planning output`,
      };
    case 'planning.ideation':
      return {
        ideas: [1, 2, 3, 4, 5].map((n) => ({
          id: `idea-${n}`,
          title: n === 1 ? 'Two Truths and a Glitch' : `${SIM} London concept ${n}`,
          format: 'REEL',
          pillar: n === 1 ? 'Entertainment & Personality' : 'Travel & Exploration',
          hook: n === 1 ? 'Three facts about me. One of them is a glitch. Go.' : `${SIM} hook ${n}`,
          concept:
            n === 1
              ? 'Jovi rapid-fires three facts about herself; the glitch is the one that reveals she is AI. Viewers guess in the comments.'
              : `${SIM} concept ${n} for Jovi in London`,
          whyNow: `${SIM} fits the awareness objective`,
          personalityTraits: ['witty', 'playful', 'confident'],
          audienceValue: `${SIM} a playful game that introduces Jovi`,
          productionNotes: [],
        })),
        recommendedIdeaIds: ['idea-1', 'idea-2'],
        selectionRationale: `${SIM} idea-1 introduces the most personality in the fewest seconds`,
      };
    default:
      return null;
  }
}

interface IdeaLike {
  title?: string;
  hook?: string;
  format?: string;
  concept?: string;
}
interface ScriptLike {
  estimatedDurationSeconds: number;
  sections: Array<{ sectionId: string; durationSeconds: number; onScreenText?: string[]; dialogue?: Array<{ line: string }> }>;
}
interface StoryboardLike {
  scenes: Array<{ sceneId: string; location: string; action: string; wardrobe: string; camera: string; lighting: string }>;
}

export function mockProduction(taskType: string, prompt: string): unknown {
  switch (taskType) {
    case 'production.script': {
      const idea = tagJson<IdeaLike>(prompt, 'idea_json') ?? {};
      const hook = idea.hook ?? 'Three facts about me. One of them is a glitch.';
      return {
        title: idea.title ?? 'Simulated script',
        hook,
        objective: `${SIM} introduce Jovi and invite comments`,
        format: idea.format ?? 'REEL',
        estimatedDurationSeconds: 15,
        language: 'en-GB',
        sections: [
          { sectionId: 's1', purpose: 'hook', durationSeconds: 3, dialogue: [{ speaker: 'JOVI', line: hook, emotion: 'playful', pacing: 'fast' }], onScreenText: ['1 of these is a glitch'], visualIntent: `${SIM} direct-to-camera café opener` },
          {
            sectionId: 's2',
            purpose: 'facts',
            durationSeconds: 8,
            dialogue: [{ speaker: 'JOVI', line: 'London is home. I rate every city by its coffee. And I have never needed sleep.', emotion: 'cheeky', pacing: 'natural' }],
            onScreenText: ['London', 'coffee critic', 'never sleeps?'],
            visualIntent: `${SIM} quick cuts through the city`,
          },
          { sectionId: 's3', purpose: 'reveal + CTA', durationSeconds: 4, dialogue: [{ speaker: 'JOVI', line: 'Which one gave me away? Tell me below.', emotion: 'warm', pacing: 'natural' }], onScreenText: ["Welcome to Jovi's Crew"], visualIntent: `${SIM} warm close-up sign-off` },
        ],
        cta: 'Which one gave me away? Tell me below.',
        personalityIntent: `${SIM} witty, confident, openly AI`,
        visualIntent: `${SIM} London café and city at golden hour`,
        audioIntent: `${SIM} Jovi voice over a light city ambience`,
        productionNotes: [`${SIM} canned script`],
      };
    }
    case 'production.storyboard': {
      const script = tagJson<ScriptLike>(prompt, 'script_json');
      const sections = script?.sections ?? [{ sectionId: 's1', durationSeconds: 3 }];
      return {
        aspectRatio: /aspect ratio: (\S+)\./i.exec(prompt)?.[1] ?? '9:16',
        continuityNotes: [`${SIM} same outfit and hair throughout`],
        scenes: sections.map((s, i) => ({
          sceneId: `sc${i + 1}`,
          sectionId: s.sectionId,
          durationSeconds: s.durationSeconds,
          purpose: `${SIM} scene for ${s.sectionId}`,
          location: i === 1 ? 'London street near a café' : 'London café by the window',
          subject: 'Jovi',
          featuresJovi: true,
          joviAppearance: 'Per the locked visual identity; same styling as the previous scene',
          action: i === 0 ? 'Looks into the lens with a coffee cup' : i === 1 ? 'Walks past shopfronts, glancing back' : 'Leans in and smiles',
          camera: i === 1 ? 'handheld tracking, 35mm' : 'static, 50mm',
          framing: i === 1 ? 'medium' : 'medium close-up',
          lighting: 'soft golden-hour window light',
          environment: 'late-afternoon London, light café bustle',
          wardrobe: 'camel trench coat over a black knit, gold hoops',
          props: ['coffee cup'],
          transition: 'cut',
          audioReference: `section ${s.sectionId}`,
          onScreenText: s.onScreenText ?? [],
          continuityRequirements: ['same wardrobe and hair as previous scene'],
        })),
      };
    }
    case 'production.visual_prompts': {
      const board = tagJson<StoryboardLike>(prompt, 'storyboard_json');
      return {
        globalStyle: `${SIM} cinematic, natural colour, shallow depth of field`,
        prompts: (board?.scenes ?? [{ sceneId: 'sc1', location: 'café', action: 'smiles', wardrobe: 'trench coat', camera: '50mm', lighting: 'window light' }]).map((s) => ({
          sceneId: s.sceneId,
          imagePrompt: `${SIM} ${s.action} in a ${s.location}, wearing ${s.wardrobe}, ${s.camera}, ${s.lighting}`,
          videoPrompt: `${SIM} ${s.action}, gentle camera motion, ${s.lighting}`,
          negativePrompt: 'blurry, low quality',
          environmentConsistency: `${SIM} same London palette as neighbouring scenes`,
          wardrobeConsistency: `${SIM} ${s.wardrobe} in every scene`,
          cameraSpecification: s.camera,
          lightingSpecification: s.lighting,
        })),
      };
    }
    case 'production.safety_review':
      // SIMULATION: a canned ALLOW. Real reviews come from a real model; heuristic checks still run.
      return {
        checks: ['adult_only', 'ai_transparency', 'identity_consistent', 'no_real_person_likeness', 'platform_safe'].map((id) => ({ id, pass: true, note: `${SIM} canned review` })),
        verdict: 'ALLOW',
        reasons: [],
      };
    case 'production.qa_review':
      return {
        reviews: [
          'personality.tone',
          'personality.dialogue',
          'personality.behavior',
          'brand.voice',
          'brand.audience_fit',
          'content.hook',
          'content.narrative',
          'content.pacing',
          'content.originality',
        ].map((checkId) => ({ checkId, score: 4, note: `${SIM} canned review` })),
        summary: `${SIM} canned QA review — not a real model judgement`,
      };
    default:
      return null;
  }
}
