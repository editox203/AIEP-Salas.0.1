import { SUPABASE_URL, SUPABASE_ANON_KEY, BACKEND_IA_URL, validarConfiguracion } from './config.js';

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

// 1. Login y bloqueo de rutas por URL
export function verificarAcceso(rolRequerido) {
  const sesion = JSON.parse(sessionStorage.getItem('sesionAiep') || 'null');
  if (!sesion) {
    window.location.replace('index.html');
    return null;
  }
  if (rolRequerido && sesion.rol !== rolRequerido) {
    const rutas = { user: 'docente.html', admin: 'coordinacion.html', superadmin: 'jefatura.html' };
    window.location.replace(rutas[sesion.rol] || 'index.html');
    return null;
  }
  return sesion;
}

export function cerrarSesion() {
  sessionStorage.removeItem('sesionAiep');
  window.location.replace('index.html');
}

export async function iniciarSesion(rut, password) {
  const q = new URLSearchParams({
    rut: `eq.${rut.trim()}`,
    password: `eq.${password}`,
    select: 'id,nombre,rut,cargo,rol,escuela'
  });
  const filas = await solicitar(`/usuarios?${q.toString()}`, { method: 'GET' });
  if (!filas || !filas.length) throw new Error('RUT o contraseña incorrectos.');
  sessionStorage.setItem('sesionAiep', JSON.stringify(filas[0]));
  return filas[0];
}

// 2. Logs de auditoría
export async function registrarLog(usuario_id, accion, ticket_id = null, detalles = '') {
  await solicitar('/historial_logs', {
    method: 'POST',
    body: JSON.stringify({ usuario_id, accion, ticket_id, detalles })
  });
}

export function obtenerLogs() {
  return solicitar('/historial_logs?select=*,usuarios(nombre,rol)&order=fecha_hora.desc&limit=60', { method: 'GET' });
}

// 3. Salas en tiempo real por bloque
export async function obtenerSalasPorBloque(fecha, horaInicio) {
  const salas = await solicitar('/salas?select=*&order=numero_sala.asc', { method: 'GET' });
  const q = new URLSearchParams({
    fecha: `eq.${fecha}`,
    estado: 'eq.1',
    select: '*,usuarios(id,nombre,rut)'
  });
  if (horaInicio) q.append('hora_inicio', `eq.${horaInicio}`);

  const ocupadas = await solicitar(`/sala_diaria?${q.toString()}`, { method: 'GET' });

  return salas.map(s => {
    const oc = ocupadas.find(o => o.sala_id === s.id);
    return {
      sala_id: s.id,
      numero_sala: s.numero_sala,
      categoria: s.categoria,
      sede: s.sede,
      ocupada: Boolean(oc),
      docente_nombre: oc?.usuarios?.nombre || '',
      docente_id: oc?.usuario_id || null,
      horario: oc ? `${oc.hora_inicio.slice(0, 5)} - ${oc.hora_fin.slice(0, 5)}` : ''
    };
  });
}

// 4. Tickets
export function obtenerTickets() {
  return solicitar(
    '/tickets_reasignacion?select=*,docente:usuarios!usuario_id(id,nombre,rut,escuela),sala_actual:salas!sala_actual_id(id,numero_sala,categoria),sala_preferida:salas!sala_preferida_id(id,numero_sala,categoria),sala_final:salas!sala_final_id(id,numero_sala,categoria)&order=fecha_creacion.desc',
    { method: 'GET' }
  );
}

export async function crearTicket(payload) {
  const filas = await solicitar('/tickets_reasignacion', {
    method: 'POST',
    body: JSON.stringify({ ...payload, estado: 'pendiente_coordinacion' })
  });
  const creado = Array.isArray(filas) ? filas[0] : filas;
  await registrarLog(payload.usuario_id, 'CREAR_TICKET', creado.id, `Bloque ${payload.bloque}: ${payload.motivo}`);
  return creado;
}

export async function derivarTicket(idTicket, coordinadorId) {
  const query = new URLSearchParams({ id: `eq.${idTicket}` });
  const filas = await solicitar(`/tickets_reasignacion?${query.toString()}`, {
    method: 'PATCH',
    body: JSON.stringify({ estado: 'pendiente_administracion' })
  });
  await registrarLog(coordinadorId, 'DERIVAR_TICKET', idTicket, 'Ticket derivado por Coordinación a Administración');
  return Array.isArray(filas) ? filas[0] : filas;
}

export async function resolverTicketAdmin(idTicket, adminId, salaFinalId, mensajeAdmin, accion) {
  const query = new URLSearchParams({ id: `eq.${idTicket}` });
  const filas = await solicitar(`/tickets_reasignacion?${query.toString()}`, {
    method: 'PATCH',
    body: JSON.stringify({
      estado: accion,
      sala_final_id: accion === 'aprobado' ? salaFinalId : null,
      mensaje_admin: mensajeAdmin
    })
  });
  await registrarLog(adminId, accion === 'aprobado' ? 'APROBAR_TICKET' : 'RECHAZAR_TICKET', idTicket, mensajeAdmin);
  return Array.isArray(filas) ? filas[0] : filas;
}

// 5. Chat privado
export function obtenerMensajesChat(ticketId) {
  return solicitar(`/chat_tickets?ticket_id=eq.${ticketId}&select=*,emisor:usuarios!emisor_id(nombre,rol)&order=fecha_envio.asc`, { method: 'GET' });
}

export async function enviarMensajeChat(ticketId, emisorId, mensaje) {
  const existentes = await obtenerMensajesChat(ticketId);
  if (existentes.length === 0) {
    await registrarLog(emisorId, 'ABRIR_CHAT_TICKET', ticketId, `Inició chat privado en Ticket #${ticketId}`);
  }
  const filas = await solicitar('/chat_tickets', {
    method: 'POST',
    body: JSON.stringify({ ticket_id: ticketId, emisor_id: emisorId, mensaje })
  });
  return Array.isArray(filas) ? filas[0] : filas;
}

// 6. Usuarios y reportes IA
export async function crearUsuarioAdmin(nuevoUsuario, adminId) {
  const filas = await solicitar('/usuarios', {
    method: 'POST',
    body: JSON.stringify(nuevoUsuario)
  });
  const creado = Array.isArray(filas) ? filas[0] : filas;
  await registrarLog(adminId, 'CREAR_USUARIO', null, `Creó usuario ${nuevoUsuario.nombre} (${nuevoUsuario.rol})`);
  return creado;
}

export function obtenerEstadisticas() {
  return solicitar('/reporte_mensual?select=cantidad_usos,horas_totales,salas(numero_sala,categoria),usuarios(nombre)', { method: 'GET' });
}

export async function generarReporteIA(pregunta, estadisticas, logs) {
  try {
    const res = await fetch(BACKEND_IA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pregunta })
    });
    if (res.ok) {
      const data = await res.json();
      return data.respuesta;
    }
  } catch (_) {}

  const ordenadas = [...estadisticas].sort((a, b) => Number(b.horas_totales) - Number(a.horas_totales));
  const mas = ordenadas[0];
  const menos = ordenadas[ordenadas.length - 1];
  return `REPORTE ESTADÍSTICO DE USO DE SALAS:\n\n` +
    `1. Sala MÁS utilizada: ${mas ? `Sala ${mas.salas?.numero_sala} (${mas.salas?.categoria}) con ${mas.horas_totales} hrs y ${mas.cantidad_usos} usos.` : 'Sin datos registrados aún.'}\n` +
    `2. Sala MENOS utilizada: ${menos ? `Sala ${menos.salas?.numero_sala} (${menos.salas?.categoria}) con ${menos.horas_totales} hrs y ${menos.cantidad_usos} usos.` : 'Sin datos registrados aún.'}\n` +
    `3. Actividad de auditoría: Se registran ${logs.length} acciones recientes en el historial del sistema.`;
}