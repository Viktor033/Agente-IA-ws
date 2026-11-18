// Validación de la configuración (.env) al arrancar.
export const DEFAULT_MODEL = 'gemini-2.5-flash';

export function checkConfig() {
  const key = process.env.GEMINI_API_KEY?.trim();
  const model = process.env.GEMINI_MODEL?.trim();
  const problems = [];

  if (!key) problems.push('Falta GEMINI_API_KEY: el agente responderá en modo local (búsqueda directa en la base).');
  else if (!/^AIza[\w-]{30,}$/.test(key))
    problems.push('GEMINI_API_KEY no tiene el formato típico de AI Studio ("AIza..."). Si Gemini falla, generá una clave en https://aistudio.google.com/apikey');

  if (!model) problems.push(`GEMINI_MODEL no definido: se usa ${DEFAULT_MODEL}.`);
  if (process.env.PORT && !/^\d+$/.test(process.env.PORT)) problems.push(`PORT inválido ("${process.env.PORT}").`);

  console.log(`⚙️  Config: modelo=${model || DEFAULT_MODEL} (fallback ${DEFAULT_MODEL}), puerto=${process.env.PORT || 3000}, clave=${key ? 'presente' : 'ausente'}`);
  for (const p of problems) console.warn('⚠️  ' + p);
  return problems;
}
