import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY, validarConfiguracion } from './config.js';

let cliente;
export function obtenerCliente() {
  const errores = validarConfiguracion();
  if (errores.length) throw new Error(errores.join(' '));
  cliente ||= createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return cliente;
}

export function escucharTiempoReal({
  alCrearTicket,
  alActualizarTicket,
  alCambiarSalas,
  alNuevoMensajeChat,
  alNuevoLog,
  alEstadoConexion
} = {}) {
  const canal = obtenerCliente()
    .channel(`canal-aiep-${Math.random().toString(36).slice(2)}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tickets_reasignacion' }, e => alCrearTicket?.(e.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tickets_reasignacion' }, e => alActualizarTicket?.(e.new))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sala_diaria' }, () => alCambiarSalas?.())
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_tickets' }, e => alNuevoMensajeChat?.(e.new))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'historial_logs' }, e => alNuevoLog?.(e.new))
    .subscribe((estado, error) => alEstadoConexion?.(estado, error));

  return () => obtenerCliente().removeChannel(canal);
}