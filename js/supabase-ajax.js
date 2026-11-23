// js/supabase-ajax.js
import { BACKEND_IA_URL } from './config.js';

const PROXY_URL = '/api/proxy';

async function llamarAPI(accion, opciones = {}) {
  const url = `${PROXY_URL}?accion=${encodeURIComponent(accion)}${opciones.params || ''}`;
  const respuesta = await fetch(url, {
    method: opciones.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opciones.body ? JSON.stringify(opciones.body) : undefined
  });

  const data = await respuesta.json();
  if (!respuesta.ok) {
    throw new Error(data.error || data.message || `Error HTTP ${respuesta.status}`);
  }
  return data;
}

export function verificarAcceso(rolRequerido) {
  const sesionStr = sessionStorage.getItem('sesionAiep');
  if (!sesionStr) {
    window.location.replace('index.html');
    return null;
  }
  try {
    const sesion = JSON.parse(sesionStr);
    if (rolRequerido && sesion.rol !== rolRequerido) {
      const rutas = { user: 'docente.html', admin: 'coordinacion.html', superadmin: 'jefatura.html' };
      window.location.replace(rutas[sesion.rol] || 'index.html');
      return null;
    }
    return sesion;
  } catch {
    cerrarSesion();
    return null;
  }
}

export function cerrarSesion() {
  sessionStorage.removeItem('sesionAiep');
  window.location.replace('index.html');
}

export async function iniciarSesion(rut, password) {
  const usuario = await llamarAPI('login', {
    method: 'POST',
    body: { rut, password }
  });
  sessionStorage.setItem('sesionAiep', JSON.stringify(usuario));
  return usuario;
}

export function obtenerUsuarios() {
  return llamarAPI('usuarios');
}

export function obtenerTickets() {
  return llamarAPI('tickets');
}

export function crearTicket(payload) {
  return llamarAPI('crear_ticket', { method: 'POST', body: payload });
}

export function derivarTicket(id, coordinador_id) {
  return llamarAPI('derivar_ticket', { method: 'POST', body: { id, coordinador_id } });
}

export function resolverTicketAdmin(id, admin_id, sala_final_id, mensaje_admin, accion) {
  return llamarAPI('resolver_ticket', {
    method: 'POST',
    body: { id, admin_id, sala_final_id, mensaje_admin, accion }
  });
}

export function obtenerHorariosProfesor(usuarioId) {
  return llamarAPI('horarios_profesor', {
    params: `&usuario_id=${encodeURIComponent(usuarioId)}`
  });
}

export function obtenerSalasDisponibles({ fecha = '', sede = '' } = {}) {
  const f = fecha ? `&fecha=${encodeURIComponent(fecha)}` : '';
  const s = sede ? `&sede=${encodeURIComponent(sede)}` : '';
  return llamarAPI('salas_disponibles', { params: `${f}${s}` });
}

export function reservarSalaManana(payload) {
  return llamarAPI('reservar_manana', { method: 'POST', body: payload });
}

export function obtenerLogs(limite = 30) {
  return llamarAPI('logs', { params: `&limite=${encodeURIComponent(limite)}` });
}

export function obtenerReportes(periodo = 'diario') {
  return llamarAPI('reportes', { params: `&periodo=${encodeURIComponent(periodo)}` });
}

export async function generarReporteIA(pregunta, estadisticas) {
  if (BACKEND_IA_URL) {
    try {
      const res = await fetch(BACKEND_IA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pregunta, estadisticas })
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.respuesta) return data.respuesta;
      }
    } catch (_) {}
  }

  try {
    const dataProxy = await llamarAPI('chat_ia', {
      method: 'POST',
      body: { pregunta, estadisticas }
    });
    return dataProxy?.respuesta || 'Sin respuesta generada.';
  } catch (err) {
    return `No se pudo conectar con el servicio de IA de NVIDIA: ${err.message}`;
  }
}