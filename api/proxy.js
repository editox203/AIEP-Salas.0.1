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
  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || '';

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Faltan variables de entorno SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en Vercel.' });
  }

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
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: text };
    }

    if (!respuesta.ok) {
      throw new Error(data?.message || data?.error || data?.details || `Error HTTP ${respuesta.status}`);
    }
    return data;
  }

  // Convierte "I007" (numero_sala) o ID numérico al ID entero de la tabla salas
  async function resolverSalaId(valor) {
    if (valor === null || valor === undefined || String(valor).trim() === '') return null;
    const str = String(valor).trim();
    if (/^\d+$/.test(str)) return Number(str);

    const filas = await llamarSupabase(`/salas?numero_sala=ilike.${encodeURIComponent(str)}&select=id`);
    if (!Array.isArray(filas) || filas.length === 0) {
      throw new Error(`No existe ninguna sala con código o ID "${str}".`);
    }
    return Number(filas[0].id);
  }

  try {
    switch (accion) {
      case 'login': {
        const { rut, password } = req.body || {};
        const usuarios = await llamarSupabase(
          `/usuarios?rut=eq.${encodeURIComponent(rut?.trim() || '')}&password=eq.${encodeURIComponent(password?.trim() || '')}&select=id,nombre,rut,cargo,rol,escuela`
        );
        if (!usuarios || usuarios.length === 0) {
          return res.status(401).json({ error: 'RUT o contraseña incorrectos.' });
        }
        return res.status(200).json(usuarios[0]);
      }

      case 'horarios_profesor': {
        const usuarioId = req.query.usuario_id;
        if (!usuarioId) {
          return res.status(400).json({ error: 'Falta usuario_id.' });
        }
        const horarios = await llamarSupabase(
          `/sala_diaria?usuario_id=eq.${encodeURIComponent(usuarioId)}&select=*,sala:salas!sala_id(id,numero_sala,categoria,sede)&order=fecha.asc,hora_inicio.asc`
        );
        const normalizados = (horarios || []).map(h => ({
          ...h,
          numero_sala: h.numero_sala || h.sala?.numero_sala || `Sala #${h.sala_id}`
        }));
        return res.status(200).json(normalizados);
      }

      case 'salas_disponibles': {
        const { fecha, sede } = req.query;
        let querySalas = '/salas?select=*&order=numero_sala.asc';
        if (sede) {
          querySalas += `&sede=eq.${encodeURIComponent(sede)}`;
        }
        const salas = await llamarSupabase(querySalas);

        let queryOcupadas = '/sala_diaria?select=sala_id,fecha,hora_inicio,hora_fin,estado,usuario_id';
        if (fecha) {
          queryOcupadas += `&fecha=eq.${encodeURIComponent(fecha)}`;
        }
        const ocupaciones = await llamarSupabase(queryOcupadas);

        const mapaOcupadas = new Map();
        for (const oc of (ocupaciones || [])) {
          const est = String(oc.estado ?? '').toLowerCase();
          const noDisp = oc.estado === 1 || est === '1' || est === 'ocupada' || est === 'bloqueada';
          if (noDisp) {
            if (!mapaOcupadas.has(oc.sala_id)) mapaOcupadas.set(oc.sala_id, []);
            mapaOcupadas.get(oc.sala_id).push(oc);
          }
        }

        const resultado = (salas || []).map(s => {
          const bloquesOcupados = mapaOcupadas.get(s.id) || [];
          return {
            ...s,
            disponible: bloquesOcupados.length === 0,
            bloques_ocupados: bloquesOcupados
          };
        });

        return res.status(200).json(resultado);
      }

      case 'tickets': {
        const tickets = await llamarSupabase(
          '/tickets_reasignacion?select=*,docente:usuarios!usuario_id(id,nombre,rut,escuela),sala_actual:salas!sala_actual_id(id,numero_sala,categoria),sala_preferida:salas!sala_preferida_id(id,numero_sala,categoria),sala_final:salas!sala_final_id(id,numero_sala,categoria)&order=fecha_creacion.desc'
        );
        return res.status(200).json(tickets || []);
      }

      case 'crear_ticket': {
        const body = req.body || {};
        const salaActualId = await resolverSalaId(body.sala_actual_id ?? body.sala_actual);
        const salaPreferidaId = await resolverSalaId(body.sala_preferida_id ?? body.sala_preferida);

        if (!salaActualId) {
          return res.status(400).json({ error: 'Debes indicar una sala actual válida (ID o código como I007).' });
        }

        const payload = {
          usuario_id: Number(body.usuario_id),
          sala_actual_id: salaActualId,
          sala_preferida_id: salaPreferidaId,
          motivo: String(body.motivo || '').trim(),
          fecha_necesitada: body.fecha_necesitada || new Date().toISOString().slice(0, 10),
          hora_inicio: body.hora_inicio || '08:30:00',
          hora_fin: body.hora_fin || '10:00:00',
          estado: 'pendiente_coordinacion'
        };

        if (body.bloque !== undefined && body.bloque !== null && String(body.bloque).trim() !== '') {
          payload.bloque = String(body.bloque).trim();
        }

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
        const resPatch = await llamarSupabase(`/tickets_reasignacion?id=eq.${encodeURIComponent(id)}`, 'PATCH', {
          estado: 'pendiente_administracion'
        });

        await llamarSupabase('/historial_logs', 'POST', {
          usuario_id: Number(coordinador_id),
          accion: 'DERIVAR_TICKET',
          ticket_id: Number(id),
          detalles: 'Ticket derivado por Coordinación a Administración'
        });

        return res.status(200).json(Array.isArray(resPatch) ? resPatch[0] : resPatch);
      }

      case 'resolver_ticket': {
        const { id, admin_id, sala_final_id, mensaje_admin, accion: accionTicket } = req.body || {};
        const esAprobado = accionTicket === 'aprobado';

        let salaAsignada = await resolverSalaId(sala_final_id);

        if (esAprobado && !salaAsignada) {
          const rows = await llamarSupabase(`/tickets_reasignacion?id=eq.${encodeURIComponent(id)}&select=sala_preferida_id,sala_actual_id`);
          const actualTicket = Array.isArray(rows) ? rows[0] : null;
          salaAsignada = actualTicket?.sala_preferida_id ?? actualTicket?.sala_actual_id ?? null;
        }

        if (esAprobado && !salaAsignada) {
          return res.status(400).json({ error: 'Debes seleccionar o tener una sala asignada antes de aprobar el ticket.' });
        }

        const payload = {
          estado: accionTicket,
          sala_final_id: esAprobado ? Number(salaAsignada) : null,
          mensaje_admin: mensaje_admin || (esAprobado ? 'Aprobado en administración' : 'Rechazado en administración')
        };

        const resPatch = await llamarSupabase(`/tickets_reasignacion?id=eq.${encodeURIComponent(id)}`, 'PATCH', payload);

        await llamarSupabase('/historial_logs', 'POST', {
          usuario_id: Number(admin_id),
          accion: esAprobado ? 'APROBAR_TICKET' : 'RECHAZAR_TICKET',
          ticket_id: Number(id),
          detalles: payload.mensaje_admin
        });

        return res.status(200).json(Array.isArray(resPatch) ? resPatch[0] : resPatch);
      }

      case 'logs': {
        const limite = Number(req.query.limite) || 50;
        const logs = await llamarSupabase(
          `/historial_logs?select=*,usuario:usuarios!usuario_id(id,nombre,rut,rol)&order=fecha_hora.desc&limit=${limite}`
        );
        return res.status(200).json(logs || []);
      }

      case 'reportes': {
        const periodo = (req.query.periodo || 'diario').toLowerCase();
        const tablaMap = {
          diario: '/reporte_diario?select=*,sala:salas!sala_id(numero_sala,sede),usuario:usuarios!usuario_id(nombre)&order=fecha.desc',
          semanal: '/reporte_semanal?select=*,sala:salas!sala_id(numero_sala,sede),usuario:usuarios!usuario_id(nombre)&order=anio.desc,semana.desc',
          mensual: '/reporte_mensual?select=*,sala:salas!sala_id(numero_sala,sede),usuario:usuarios!usuario_id(nombre)&order=anio.desc,mes.desc',
          anual: '/reporte_anual?select=*,sala:salas!sala_id(numero_sala,sede),usuario:usuarios!usuario_id(nombre)&order=anio.desc'
        };
        const endpoint = tablaMap[periodo] || tablaMap.diario;
        const datos = await llamarSupabase(endpoint);
        return res.status(200).json(datos || []);
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