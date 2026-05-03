import { fetchJSON } from '../http.mjs';

async function lookup(compoundName) {
  const url = `https://www.ebi.ac.uk/chembl/api/data/molecule?pref_name__iexact=${encodeURIComponent(compoundName)}&format=json`;
  let data = await fetchJSON(url);
  if (!data?.molecules?.length) {
    const searchUrl = `https://www.ebi.ac.uk/chembl/api/data/molecule/search?q=${encodeURIComponent(compoundName)}&format=json`;
    data = await fetchJSON(searchUrl);
  }
  if (!data?.molecules?.length) return null;
  const mol = data.molecules[0];
  return {
    source: 'chembl',
    chemblId: mol.molecule_chembl_id,
    name: mol.pref_name,
    formula: mol.molecule_properties?.full_molformula || null,
    molecularWeight: mol.molecule_properties?.full_mwt || null,
    maxPhase: mol.max_phase,
    firstApproval: mol.first_approval,
    naturalProduct: !!mol.natural_product,
    atcClassifications: mol.atc_classifications || [],
    synonyms: (mol.molecule_synonyms || []).map((s) => s.molecule_synonym || s.synonyms),
    url: `https://www.ebi.ac.uk/chembl/compound_report_card/${mol.molecule_chembl_id}/`,
  };
}

export default { id: 'chembl', lookup };
