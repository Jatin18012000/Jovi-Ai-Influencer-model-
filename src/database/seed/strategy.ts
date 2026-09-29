import type { StrategyContent } from '../../core/strategy/strategy-schema.js';

/**
 * Initial strategy version (v1). Numbers here are starting guidelines recorded
 * in a versioned row — the strategy engine never hard-codes them, and later
 * versions (from the Learning/Strategy agents) can replace them.
 */
export const INITIAL_STRATEGY = {
  name: 'Awareness & Community Launch',
  objective: "Build awareness and community around Jovi's identity.",
  rationale:
    'Launch strategy from the Phase 5 specification: lead with core pillars, rotate supporting pillars, use Reels for discovery and Stories for relationship.',
  content: {
    approach: 'CORE_PLUS_ROTATION',
    approachDescription:
      'Core pillars carry most content; supporting pillars rotate in to keep Jovi multidimensional and test new audience interest.',
    corePillars: ['Travel & Exploration', 'Fashion & Beauty', 'Entertainment & Personality'],
    supportingPillars: [
      'Lifestyle & Everyday Life',
      'Cars & Luxury',
      'AI, Technology & Future',
      'Business & Ambition',
      'Culture & World',
    ],
    formatPriorities: [
      { format: 'REEL', priority: 1, role: 'Main discovery mechanism' },
      { format: 'STORY', priority: 2, role: 'Main relationship / community mechanism' },
      { format: 'CAROUSEL', priority: 3, role: 'Depth, recommendations, saves' },
      { format: 'PHOTO', priority: 4, role: 'Aesthetic anchors and identity consistency' },
    ],
    cadence: {
      guideline: '1–2 feed pieces per day plus frequent Stories',
      enforcement: 'GUIDELINE',
    },
    contentMix: {
      original: 0.6,
      trend: 0.4,
      enforcement: 'GUIDELINE',
      note: 'Initial starting point only. Must evolve with performance data; not a permanent rule.',
    },
    contentPhilosophy: ['Experience', 'Story', 'Personality', 'Community'],
    guidelines: [
      'Jovi is the recurring reason people follow — personality over generic information.',
      'Every piece should reveal something about Jovi (taste, humour, opinion, habit).',
      "Invite Jovi's Crew into the moment: questions, choices, inside jokes, recommendations.",
      'Avoid generic influencer templates unless Jovi clearly subverts them.',
      'Openly AI: lean into it with confidence and wit, never deception.',
    ],
  },
} satisfies { name: string; objective: string; rationale: string; content: StrategyContent };
