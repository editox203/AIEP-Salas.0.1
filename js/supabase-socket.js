// js/supabase-socket.js
// Nota: Para mantener las credenciales seguras en el servidor (Node.js), 
// el tiempo real se maneja mediante simulación de intervalos o eventos web si prefieres no exponer la key anon en cliente.
export function escucharTiempoReal({ alCrearTicket, alActualizarTicket, alEstadoConexion }) {
  if (alEstadoConexion) alEstadoConexion('SUBSCRIBED');

  // Sondeo periódico ligero cada 5 segundos para mantener sincronización en tiempo real sin exponer credenciales en el cliente
  const intervalo = setInterval(async () => {
    try {
      const res = await fetch('/api/proxy?accion=tickets');
      if (res.ok) {
        const data = await res.json();
        data.forEach(t => alActualizarTicket(t));
      }
    } catch (_) {}
  }, 5000);

  return {
    desuscribir: () => clearInterval(intervalo)
  };
}