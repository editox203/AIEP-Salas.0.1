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

  function obtenerFechaChile(offsetDias = 0) {
    const ahoraChile = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Santiago' }));
    ahoraChile.setDate(ahoraChile.getDate() + offsetDias);
    const yyyy = ahoraChile.getFullYear();
    const mm = String(ahoraChile.getMonth() + 1).padStart(2, '0');
    const dd = String(ahoraChile.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  function obtenerFechaMananaChile() {
    return obtenerFechaChile(1);
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

      case 'usuarios': {
        const usuarios = await llamarSupabase(
          '/usuarios?select=id,nombre,rut,cargo,rol,escuela&order=nombre.asc'
        );
        return res.status(200).json(usuarios || []);
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
        const fechaObjetivo = fecha || obtenerFechaChile(0);
        let querySalas = '/salas?select=*&order=numero_sala.asc';
        if (sede) {
          querySalas += `&sede=eq.${encodeURIComponent(sede)}`;
        }
        const salas = await llamarSupabase(querySalas);

        const ocupaciones = await llamarSupabase(
          `/sala_diaria?fecha=eq.${encodeURIComponent(fechaObjetivo)}&select=sala_id,fecha,hora_inicio,hora_fin,estado,usuario_id,usuario:usuarios!usuario_id(id,nombre)`
        );

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
            fecha_consultada: fechaObjetivo,
            disponible: bloquesOcupados.length === 0,
            bloques_ocupados: bloquesOcupados
          };
        });

        return res.status(200).json(resultado);
      }

      case 'calendario_salas': {
        const fechaHoy = obtenerFechaChile(0);
        const fechaManana = obtenerFechaChile(1);

        const [salas, reservasHoy, reservasManana] = await Promise.all([
          llamarSupabase('/salas?select=*&order=numero_sala.asc'),
          llamarSupabase(`/sala_diaria?fecha=eq.${encodeURIComponent(fechaHoy)}&select=sala_id,fecha,hora_inicio,hora_fin,numero_sala,nrc,categoria,sede,estado,usuario_id,usuario:usuarios!usuario_id(id,nombre)&order=hora_inicio.asc`),
          llamarSupabase(`/sala_diaria?fecha=eq.${encodeURIComponent(fechaManana)}&select=sala_id,fecha,hora_inicio,hora_fin,numero_sala,nrc,categoria,sede,estado,usuario_id,usuario:usuarios!usuario_id(id,nombre)&order=hora_inicio.asc`)
        ]);

        const esOcupado = oc => {
          const est = String(oc.estado ?? '').toLowerCase();
          return oc.estado === 1 || est === '1' || est === 'ocupada' || est === 'bloqueada';
        };

        const hoyPorSala = new Map();
        for (const r of (reservasHoy || [])) {
          if (!esOcupado(r)) continue;
          if (!hoyPorSala.has(r.sala_id)) hoyPorSala.set(r.sala_id, []);
          hoyPorSala.get(r.sala_id).push(r);
        }

        const mananaPorSala = new Map();
        for (const r of (reservasManana || [])) {
          if (!esOcupado(r)) continue;
          if (!mananaPorSala.has(r.sala_id)) mananaPorSala.set(r.sala_id, []);
          mananaPorSala.get(r.sala_id).push(r);
        }

        const salasCalendario = (salas || []).map(s => {
          const bloquesHoy = hoyPorSala.get(s.id) || [];
          const bloquesManana = mananaPorSala.get(s.id) || [];
          return {
            ...s,
            disponible_hoy: bloquesHoy.length === 0,
            bloques_hoy: bloquesHoy,
            reservas_manana: bloquesManana
          };
        });

        return res.status(200).json({
          hoy: fechaHoy,
          manana: fechaManana,
          salas: salasCalendario
        });
      }

      case 'reservar_manana': {
        const { sala_id, usuario_id, asignado_por_id, hora_inicio, hora_fin, motivo } = req.body || {};
        const salaResuelta = await resolverSalaId(sala_id);
        const profesorId = Number(usuario_id || asignado_por_id);
        const actorId = Number(asignado_por_id || usuario_id);

        if (!salaResuelta || !profesorId) {
          return res.status(400).json({ error: 'Falta sala_id o profesor para reservar.' });
        }

        const fechaManana = obtenerFechaMananaChile();
        const inicio = hora_inicio || '08:30:00';
        const fin = hora_fin || '10:00:00';

        const salasInfo = await llamarSupabase(`/salas?id=eq.${salaResuelta}&select=id,numero_sala,nrc,categoria,sede`);
        const salaObj = Array.isArray(salasInfo) && salasInfo[0] ? salasInfo[0] : {};

        const usuariosInfo = await llamarSupabase(`/usuarios?id=eq.${profesorId}&select=id,nombre`);
        const profObj = Array.isArray(usuariosInfo) && usuariosInfo[0] ? usuariosInfo[0] : null;

        const registro = {
          sala_id: salaResuelta,
          fecha: fechaManana,
          hora_inicio: inicio,
          hora_fin: fin,
          numero_sala: salaObj.numero_sala || null,
          nrc: salaObj.nrc || null,
          categoria: salaObj.categoria || null,
          sede: salaObj.sede || null,
          estado: 1,
          usuario_id: profesorId
        };

        const guardado = await llamarSupabase('/sala_diaria', 'POST', registro);

        await llamarSupabase('/historial_logs', 'POST', {
          usuario_id: actorId,
          accion: 'CREAR_TICKET',
          ticket_id: null,
          detalles: `Reserva día siguiente (${fechaManana} ${inicio}-${fin}) en sala ${salaObj.numero_sala || salaResuelta} asignada a ${profObj?.nombre || `Usuario #${profesorId}`}${motivo ? ` · ${motivo}` : ''}`
        });

        return res.status(200).json({
          fecha: fechaManana,
          reserva: Array.isArray(guardado) ? guardado[0] : guardado
        });
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
          fecha_necesitada: body.fecha_necesitada || obtenerFechaMananaChile(),
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
          return res.status(400).json({ error: 'Debes seleccionar la sala final antes de aprobar el ticket.' });
        }

        const payload = {
          estado: accionTicket,
          sala_final_id: esAprobado ? Number(salaAsignada) : null,
          mensaje_admin: mensaje_admin || (esAprobado ? `Aprobado con sala ID ${salaAsignada}` : 'Rechazado en administración')
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
              {
                role: 'system',
                content: 'Eres un asistente administrativo experto en gestión de salas AIEP. Resume y analiza métricas, reportes estadísticos, tickets y disponibilidad de salas de forma clara, ejecutiva y accionable.'
              },
              {
                role: 'user',
                content: `Datos estadísticos / reporte actual:\n${typeof estadisticas === 'string' ? estadisticas : JSON.stringify(estadisticas, null, 2)}\n\nInstrucción / Pregunta de Jefatura:\n${pregunta || 'Resume este reporte estadístico y destaca los puntos clave.'}`
              }
            ],
            temperature: 0.7,
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