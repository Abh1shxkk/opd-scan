/**
 * Defect codes and labels, mirrored verbatim from
 * backend/app/processing/quality/rules.py (DEFECT_LABELS / DEFECT_ORDER).
 *
 * The backend sends a `label` with each finding; this table is the fallback for places where only
 * a code is available (filter chips, export column values, defect breakdown legends) and it fixes
 * the display order so the dashboard and the filter bar agree.
 *
 * Handwriting is deliberately absent. Handwriting is not a scan-quality defect (rules.py docstring,
 * rule 3) and must never appear in a defect list or defect count.
 */

export const DEFECT_CODES = [
  'blur',
  'faint',
  'dark',
  'low_contrast',
  'noise',
  'rotated',
  'skewed',
  'glare',
  'shadow',
  'unreadable_region',
  'suspected_cutoff',
  'bitonal_loss',
  'low_resolution',
  'near_blank',
] as const;

export type DefectCode = (typeof DEFECT_CODES)[number];

export const DEFECT_LABELS: Record<string, string> = {
  blur: 'Blurred / out of focus',
  faint: 'Faint — ink barely separated from paper',
  dark: 'Under-exposed / too dark',
  low_contrast: 'Low overall contrast',
  noise: 'Noisy / speckled',
  rotated: 'Incorrectly rotated',
  skewed: 'Excessively skewed',
  glare: 'Glare / blown highlights',
  shadow: 'Shadow across the page',
  unreadable_region: 'Region(s) likely unreadable',
  suspected_cutoff: 'Suspected cut-off page edge or text',
  bitonal_loss: 'Saved as 1-bit — mid-tones lost',
  low_resolution: 'Text too small for reliable reading',
  near_blank: 'Nearly blank',
};

/**
 * Short families used to group the threshold editor on Settings. Purely presentational; the
 * threshold keys themselves are what the API stores.
 */
export const DEFECT_FAMILIES: Array<{ id: string; title: string; blurb: string; keys: string[] }> = [
  {
    id: 'blank',
    title: 'Blank and near-blank',
    blurb:
      'A blank page is its own class. It is never counted as acceptable and never as a defect — blank facing pages inside a bound spread are usually deliberate.',
    keys: ['blank_ink_coverage', 'blank_component_count', 'near_blank_ink_coverage'],
  },
  {
    id: 'sharpness',
    title: 'Sharpness',
    blurb:
      'Stroke sharpness is resolution independent and is never applied to bitonal pages, which look sharp by construction.',
    keys: ['sharpness_min', 'sharpness_severe', 'sharpness_min_ink_coverage'],
  },
  {
    id: 'contrast',
    title: 'Faintness and contrast',
    blurb:
      'Measured on ink-versus-paper separation, not on the page’s dynamic range: sparse clean writing on white paper is readable despite a small range.',
    keys: ['faint_ink_paper_contrast', 'faint_severe_contrast', 'low_contrast_ink_paper'],
  },
  {
    id: 'exposure',
    title: 'Exposure',
    blurb: 'Median luminance of the sheet, 0–255.',
    keys: ['dark_median_luma', 'dark_severe_median_luma'],
  },
  {
    id: 'noise',
    title: 'Noise',
    blurb: 'Sensor and compression noise, judged against ink contrast (SNR).',
    keys: ['noise_sigma', 'noise_sigma_severe', 'min_snr'],
  },
  {
    id: 'geometry',
    title: 'Geometry — rotation and skew',
    blurb:
      'Image-only orientation detection cannot separate a sideways page from an upright page with tall ruled columns, so a confident signal raises a rescan and an uncertain one only asks for a human glance.',
    keys: [
      'skew_deg',
      'skew_severe_deg',
      'rotation_confident',
      'rotation_uncertain',
      'orientation_min_components',
    ],
  },
  {
    id: 'illumination',
    title: 'Illumination — glare and shadow',
    blurb: 'Relevant mainly to the overhead camera captures of bound case files.',
    keys: [
      'glare_area_fraction',
      'glare_area_fraction_severe',
      'shadow_area_fraction',
      'illumination_ratio',
    ],
  },
  {
    id: 'localisation',
    title: 'Unreadable areas',
    blurb: 'Fraction of content tiles with too little ink/paper separation to read.',
    keys: ['unreadable_tile_fraction'],
  },
  {
    id: 'resolution',
    title: 'Resolution',
    blurb: 'Estimated character height in pixels.',
    keys: ['min_text_height_px'],
  },
  {
    id: 'classification',
    title: 'Classification cut-offs',
    blurb:
      'Weighted severity totals (low 1.0, medium 2.5, high 6.0). A single high-severity legibility problem forces a rescan regardless of the total.',
    keys: ['rescan_severity_score', 'review_severity_score'],
  },
];

export function defectLabel(code: string, supplied?: string | null): string {
  return supplied || DEFECT_LABELS[code] || code;
}

/**
 * Cut-off can never be confirmed from the image alone (rules.py rule 4), so the UI adds this
 * caveat wherever a cut-off finding is shown on its own.
 */
export const CUTOFF_CAVEAT =
  'Suspected only — content beyond the edge of the capture cannot be confirmed from the image.';

export function isCutoff(code: string): boolean {
  return code === 'suspected_cutoff';
}
