export interface SoundVariant {
  id: string;
  label: string;
  description: string;
  /** Attack variants use the duration arg; hit variants ignore it. */
  play(duration?: number): { stop: (at?: number) => void };
}

export interface VariantSet {
  title: string;
  attacks: SoundVariant[];
  hits: SoundVariant[];
  /** true = attacks are continuous (expose duration slider); false = one-shot burst. */
  attacksAreContinuous?: boolean;
  attackSectionSubtitle?: string;
  hitSectionSubtitle?: string;
}
