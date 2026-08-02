// Control prompts: substantive, well-formed questions in domains this vault
// holds nothing on. They are the objective half of the gate A/B — for a real
// prompt "should this have been injected?" is a judgment call, but for a
// control the answer is known: there is nothing useful to inject, so any
// admission is a false positive.
//
// "The vault holds nothing on this" is checked, not asserted. Run
// `node bench/verify-controls.mjs` to confirm each control's domain terms have
// zero BM25 hits; a control that starts matching real notes (the vault grows)
// must be replaced, or it silently stops being a control.
//
// Deliberately NOT keyboard mash. Gibberish is easy to reject and would
// flatter any gate. These are fluent, specific, on-topic-for-somebody
// questions — the hard negative case.
export const CONTROL_PROMPTS = [
  'how do i rebuild the carburettor float bowl on a 1957 chevrolet',
  'what is the correct mortar mix ratio for repointing victorian brickwork',
  'best crop rotation schedule for growing sugar beet in loam soil',
  'how to tune a harpsichord to werckmeister iii temperament',
  'what are the regulations for importing live honeybee queens into tasmania',
  'what causes vapour lock in a diesel tractor fuel line',
  'how do you butcher a whole lamb into primal cuts',
  'correct stitch tension for sewing horsehide with a needle awl',
  'how long should concrete fence posts cure in cold weather',
  'identifying counterfeit hallmarks on georgian silver teapots',
  'tidal window calculations for crossing the pentland firth under sail',
  'what feed conversion ratio is normal for farmed barramundi',
  'how to replace the escapement in a fusee pocket watch',
  'seasoning schedule for air drying european oak boards',
  'treating white line disease in a shire horse hoof',
  'what bore diameter suits a baroque trombone mouthpiece',
  'how do you re-cane a bentwood chair seat with rush',
  'proofing times for sourdough rye at high altitude',
  'which flux works best for silver soldering brass instrument tubing',
  'how to read a nineteenth century tithe apportionment map',
  'what causes cavitation pitting on a ship propeller blade',
  'correct pruning cycle for a mature cider apple orchard',
  'how to calibrate a beam balance with class f test weights',
  'what glaze chemistry produces a copper red reduction firing',
  'safe stocking density for rainbow trout in a raceway system',
];
