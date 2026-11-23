// api/proxy.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { accion } = req.query;
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://TU-PROYECTO.supabase.co/rest/v1';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'TU_CLAVE';
  const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || '';

  async function llamarSupabase(endpoint, metodo = 'GET', body = null) {
    const respuesta = await fetch(`${SUPABASE_URL}${endpoint}`, {
      method: metodo,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await respuesta.text();
    const data = text ? JSON.parse(text) : null;
    if (!respuesta.ok) {
      throw new Error(data?.message || data?.error || `Error HTTP ${respuesta.status}`);
    }
    return data;
  }

  try {
    switch (accion) {
      case 'login': {
        const { rut, password } = req.body || {};
        const usuarios = await llamarSupabase(`/usuarios?rut=eq.${encodeURIComponent(rut?.trim())}&password=eq.${encodeURIComponent(password?.trim())}&select=id,nombre,rut,cargo,rol,escuela`);
        if (!usuarios || usuarios.length === 0) {
          return res.status(401).json({ error: 'RUT o contraseña incorrectos.' });
        }
        return res.status(200).json(usuarios[0]);
      }

      case 'tickets': {
        const tickets = await llamarSupabase('/tickets_reasignacion?select=*,docente:usuarios!usuario_id(id,nombre,rut,escuela),sala_actual:salas!sala_actual_id(id,numero_sala,categoria),sala_preferida:salas!sala_preferida_id(id,numero_sala,categoria),sala_final:salas!sala_final_id(id,numero_sala,categoria)&order=fecha_creacion.desc');
        return res.status(200).json(tickets);
      }

      case 'crear_ticket': {
        const payload = { ...(req.body || {}), estado: 'pendiente_coordinacion' };
        const creado = await llamarSupabase('/tickets_reasignacion', 'POST', payload);
        const ticket = Array.isArray(creado) ? creado[0] : creado;

        await llamarSupabase('/historial_logs', 'POST', {
          usuario_id: payload.usuario_id,
          accion: 'CREAR_TICKET',
          ticket_id: ticket.id,
          detalles: payload.bloque ? `Bloque ${payload.bloque}: ${payload.motivo}` : payload.motivo
        });
        return res.status(200).json(ticket);
      }

      case 'derivar_ticket': {
        const { id, coordinador_id } = req.body || {};
        const resPatch = await llamarSupabase(`/tickets_reasignacion?id=eq.${id}`, 'PATCH', { estado: 'pendiente_administracion' });
        await llamarSupabase('/historial_logs', 'POST', {
          usuario_id: coordinador_id,
          accion: 'DERIVAR_TICKET',
          ticket_id: id,
          detalles: 'Ticket derivado por Coordinación a Administración'
        });
        return res.status(200).json(Array.isArray(resPatch) ? resPatch[0] : resPatch);
      }

      case 'resolver_ticket': {
        const { id, admin_id, sala_final_id, mensaje_admin, accion: accionTicket } = req.body || {};
        const esAprobado = accionTicket === 'aprobado';

        let salaAsignada = sala_final_id || null;

        if (esAprobado && !salaAsignada) {
          const rows = await llamarSupabase(`/tickets_reasignacion?id=eq.${id}&select=sala_preferida_id,sala_actual_id`);
          const actualTicket = Array.isArray(rows) ? rows[0] : null;
          salaAsignada = actualTicket?.sala_preferida_id ?? actualTicket?.sala_actual_id ?? null;
        }

        if (esAprobado && !salaAsignada) {
          return res.status(400).json({ error: 'Debes seleccionar o tener una sala asignada (sala_final_id) para aprobar el ticket.' });
        }

        const payload = {
          estado: accionTicket,
          sala_final_id: esAprobado ? salaAsignada : null,
          mensaje_admin: mensaje_admin || (esAprobado ? 'Aprobado en administración' : 'Rechazado en administración')
        };

        const resPatch = await llamarSupabase(`/tickets_reasignacion?id=eq.${id}`, 'PATCH', payload);

        await llamarSupabase('/historial_logs', 'POST', {
          usuario_id: admin_id,
          accion: esAprobado ? 'APROBAR_TICKET' : 'RECHAZAR_TICKET',
          ticket_id: id,
          detalles: payload.mensaje_admin
        });

        return res.status(200).json(Array.isArray(resPatch) ? resPatch[0] : resPatch);
      }

      case 'chat_ia': {
        const { pregunta, estadisticas } = req.body || {};
        if (!NVIDIA_API_KEY) {
          return res.status(500).json({ error: 'Falta configurar la NVIDIA_API_KEY en Vercel.' });
        }

        const nvidiaRes = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${NVIDIA_API_KEY}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            model: 'nvidia/nemotron-3.5-bolt-e4b',
            messages: [
              { role: 'system', content: 'Eres un asistente administrativo experto en la gestión y análisis de uso de salas de AIEP.' },
              { role: 'user', content: `Estadísticas actuales del sistema: ${JSON.stringify(estadisticas)}\n\nPregunta de Jefatura: ${pregunta}` }
            ],
            temperature: 1,
            top_p: 0.95,
            max_tokens: 1024,
            seed: 42,
            stream: false,
            chat_template_kwargs: { enable_thinking: true }
          })
        });

        const nvidiaData = await nvidiaRes.json();
        if (!nvidiaRes.ok) {
          throw new Error(nvidiaData?.error?.message || 'Error al comunicarse con la IA de NVIDIA.');
        }

        const respuestaTexto = nvidiaData.choices?.[0]?.message?.content || 'Sin respuesta generada.';
        return res.status(200).json({ respuesta: respuestaTexto });
      }

      default:
        return res.status(400).json({ error: 'Acción no válida' });
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}