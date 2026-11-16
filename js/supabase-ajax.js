import { SUPABASE_URL, SUPABASE_ANON_KEY, validarConfiguracion } from './config.js';

const REST_URL = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;

function revisarConfiguracion() {
  const errores = validarConfiguracion();
  if (errores.length) throw new Error(errores.join(' '));
}

async function solicitar(ruta, opciones = {}) {
  revisarConfiguracion();
  const respuesta = await fetch(`${REST_URL}${ruta}`, {
    ...opciones,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...opciones.headers
    }
  });

  const texto = await respuesta.text();
  let resultado = null;
  if (texto) {
    try { resultado = JSON.parse(texto); }
    catch { resultado = texto; }
  }
  if (!respuesta.ok) {
    const detalle = resultado?.message || resultado?.hint || resultado?.details || `HTTP ${respuesta.status}`;
    throw new Error(`Supabase: ${detalle}`);
  }
  return resultado;
}

export function obtenerTickets() {
  return solicitar('/tickets?select=*&order=created_at.desc', { method: 'GET' });
}

export async function crearTicket(sala, categoria, descripcion, docente) {
  const payload = {
    room_code: sala.trim(),
    category: categoria.trim(),
    description: descripcion.trim(),
    teacher_name: docente.nombre.trim(),
    teacher_rut: docente.rut.trim(),
    status: 'open'
  };
  const filas = await solicitar('/tickets', { method: 'POST', body: JSON.stringify(payload) });
  return Array.isArray(filas) ? filas[0] : filas;
}

export async function cambiarEstadoTicket(idTicket, nuevoEstado, notas = '') {
  const id = encodeURIComponent(String(idTicket));
  const query = new URLSearchParams({ id: `eq.${idTicket}` });
  const filas = await solicitar(`/tickets?${query.toString()}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: nuevoEstado, escalation_notes: notas })
  });
  return Array.isArray(filas) ? filas[0] : filas;
}
