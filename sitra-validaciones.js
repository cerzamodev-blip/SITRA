// ====================================
// TOURFLEET - MÓDULO DE VALIDACIONES
// ====================================
// Este módulo valida asignaciones inteligentemente considerando:
// - Conflictos de horario del chofer
// - Descanso obligatorio del chofer
// - Capacidad del vehículo
// - Combustible disponible
// - Paradas de combustible necesarias

const ValidationModule = {
    // Configuración
    CONFIG: {
        HORAS_DESCANSO_MINIMO: 8,        // 8 horas entre servicios
        HORAS_MAXIMAS_DIARIAS: 12,       // Máximo 12 horas al día
        DIAS_TRABAJO_CONSECUTIVOS: 6,    // Máximo 6 días consecutivos
        KM_POR_GALON: 8,                 // Rendimiento promedio
        CAPACIDAD_TANQUE: 80,            // Galones promedio
        MARGEN_SEGURIDAD_COMBUSTIBLE: 0.2 // 20% de margen
    },

    // ====================================
    // VALIDACIÓN PRINCIPAL DE ASIGNACIÓN
    // ====================================
    async validarAsignacion(asignacionData, supabase) {
        const errores = [];
        const advertencias = [];

        // 1. Validar conflicto de horario del chofer
        const conflictoHorario = await this.validarConflictoHorario(
            asignacionData.chofer_id,
            asignacionData.fecha_servicio,
            asignacionData.hora_salida,
            asignacionData.duracion_estimada_minutos,
            supabase
        );
        if (!conflictoHorario.valido) {
            errores.push(conflictoHorario.mensaje);
        }

        // 2. Validar descanso del chofer
        const descanso = await this.validarDescansoChofer(
            asignacionData.chofer_id,
            asignacionData.fecha_servicio,
            asignacionData.hora_salida,
            supabase
        );
        if (!descanso.valido) {
            if (descanso.critico) {
                errores.push(descanso.mensaje);
            } else {
                advertencias.push(descanso.mensaje);
            }
        }

        // 3. Validar capacidad del vehículo
        const capacidad = await this.validarCapacidadVehiculo(
            asignacionData.vehiculo_id,
            asignacionData.pasajeros,
            supabase
        );
        if (!capacidad.valido) {
            errores.push(capacidad.mensaje);
        }

        // 4. Validar combustible disponible
        const combustible = await this.validarCombustible(
            asignacionData.vehiculo_id,
            asignacionData.distancia_km,
            supabase
        );
        if (!combustible.valido) {
            if (combustible.critico) {
                errores.push(combustible.mensaje);
            } else {
                advertencias.push(combustible.mensaje);
            }
        }

        // 5. Calcular paradas de combustible necesarias
        const paradasCombustible = await this.calcularParadasCombustible(
            asignacionData.distancia_km,
            asignacionData.vehiculo_id,
            supabase
        );

        return {
            valido: errores.length === 0,
            errores: errores,
            advertencias: advertencias,
            paradasCombustible: paradasCombustible,
            detalles: {
                conflictoHorario,
                descanso,
                capacidad,
                combustible
            }
        };
    },

    // ====================================
    // VALIDAR CONFLICTO DE HORARIO
    // ====================================
    async validarConflictoHorario(choferId, fechaServicio, horaSalida, duracionMinutos, supabase) {
        try {
            // Calcular hora de llegada estimada
            const horaLlegada = this.calcularHoraLlegada(horaSalida, duracionMinutos);

            // Buscar asignaciones del chofer en la misma fecha
            const { data: asignaciones, error } = await supabase
                .from('tf_asignaciones')
                .select(`
                    *,
                    servicio:tf_servicios(
                        fecha_servicio,
                        hora_salida,
                        hora_llegada_estimada
                    ),
                    ruta:tf_rutas(duracion_estimada_minutos)
                `)
                .eq('chofer_id', choferId)
                .eq('servicio.fecha_servicio', fechaServicio)
                .neq('estado', 'cancelado');

            if (error) throw error;

            // Verificar conflictos
            for (const asig of asignaciones || []) {
                const servicioExistente = asig.servicio;
                const horaInicioExistente = servicioExistente.hora_salida;
                const duracionExistente = asig.ruta?.duracion_estimada_minutos || 0;
                const horaFinExistente = this.calcularHoraLlegada(horaInicioExistente, duracionExistente);

                // Agregar margen de 30 minutos entre servicios
                const horaFinConMargen = this.agregarMinutos(horaFinExistente, 30);

                // Verificar solapamiento
                if (this.hayConflictoHorario(horaSalida, horaLlegada, horaInicioExistente, horaFinConMargen)) {
                    return {
                        valido: false,
                        critico: true,
                        mensaje: `❌ CONFLICTO: El chofer ya tiene un servicio de ${horaInicioExistente} a ${horaFinConMargen}. No puede estar en dos lugares al mismo tiempo.`,
                        conflicto: {
                            servicioExistente: asig.servicio.codigo,
                            horaInicio: horaInicioExistente,
                            horaFin: horaFinConMargen
                        }
                    };
                }
            }

            return {
                valido: true,
                mensaje: '✅ No hay conflictos de horario'
            };

        } catch (error) {
            console.error('Error validando conflicto de horario:', error);
            return {
                valido: false,
                critico: true,
                mensaje: '❌ Error al validar conflicto de horario: ' + error.message
            };
        }
    },

    // ====================================
    // VALIDAR DESCANSO DEL CHOFER
    // ====================================
    async validarDescansoChofer(choferId, fechaServicio, horaSalida, supabase) {
        try {
            // 1. Verificar horas trabajadas en el día
            const horasDelDia = await this.calcularHorasTrabajadas(
                choferId, 
                fechaServicio, 
                supabase
            );

            if (horasDelDia >= this.CONFIG.HORAS_MAXIMAS_DIARIAS) {
                return {
                    valido: false,
                    critico: true,
                    mensaje: `❌ CRÍTICO: El chofer ya trabajó ${horasDelDia} horas hoy. Máximo permitido: ${this.CONFIG.HORAS_MAXIMAS_DIARIAS} horas por día.`
                };
            }

            // 2. Verificar descanso desde último servicio
            const ultimoServicio = await this.obtenerUltimoServicio(choferId, fechaServicio, supabase);
            
            if (ultimoServicio) {
                const horasDescanso = this.calcularHorasDescanso(
                    ultimoServicio.fecha_fin,
                    ultimoServicio.hora_fin,
                    fechaServicio,
                    horaSalida
                );

                if (horasDescanso < this.CONFIG.HORAS_DESCANSO_MINIMO) {
                    return {
                        valido: false,
                        critico: true,
                        mensaje: `❌ CRÍTICO: El chofer solo descansó ${horasDescanso.toFixed(1)} horas desde su último servicio. Mínimo requerido: ${this.CONFIG.HORAS_DESCANSO_MINIMO} horas.`
                    };
                }
            }

            // 3. Verificar días trabajados consecutivos
            const diasConsecutivos = await this.calcularDiasConsecutivos(choferId, fechaServicio, supabase);
            
            if (diasConsecutivos >= this.CONFIG.DIAS_TRABAJO_CONSECUTIVOS) {
                return {
                    valido: false,
                    critico: false,
                    mensaje: `⚠️ ADVERTENCIA: El chofer ha trabajado ${diasConsecutivos} días consecutivos. Se recomienda asignar un día de descanso.`
                };
            }

            // Todo OK
            return {
                valido: true,
                mensaje: `✅ El chofer cumple con las horas de descanso (${horasDelDia} horas trabajadas hoy, ${diasConsecutivos} días consecutivos)`
            };

        } catch (error) {
            console.error('Error validando descanso:', error);
            return {
                valido: false,
                critico: false,
                mensaje: '⚠️ Error al validar descanso del chofer: ' + error.message
            };
        }
    },

    // ====================================
    // VALIDAR CAPACIDAD DEL VEHÍCULO
    // ====================================
    async validarCapacidadVehiculo(vehiculoId, numeroPasajeros, supabase) {
        try {
            const { data: vehiculo, error } = await supabase
                .from('tf_vehiculos')
                .select('capacidad, codigo, marca, modelo')
                .eq('id', vehiculoId)
                .single();

            if (error) throw error;

            if (numeroPasajeros > vehiculo.capacidad) {
                return {
                    valido: false,
                    critico: true,
                    mensaje: `❌ CAPACIDAD EXCEDIDA: El vehículo ${vehiculo.codigo} (${vehiculo.marca} ${vehiculo.modelo}) tiene capacidad para ${vehiculo.capacidad} pasajeros, pero se intentan asignar ${numeroPasajeros}.`
                };
            }

            // Advertencia si está cerca del límite
            const porcentajeOcupacion = (numeroPasajeros / vehiculo.capacidad) * 100;
            if (porcentajeOcupacion > 90) {
                return {
                    valido: true,
                    mensaje: `⚠️ ADVERTENCIA: El vehículo estará al ${porcentajeOcupacion.toFixed(0)}% de su capacidad (${numeroPasajeros}/${vehiculo.capacidad} pasajeros).`
                };
            }

            return {
                valido: true,
                mensaje: `✅ Capacidad adecuada: ${numeroPasajeros}/${vehiculo.capacidad} pasajeros (${porcentajeOcupacion.toFixed(0)}%)`
            };

        } catch (error) {
            console.error('Error validando capacidad:', error);
            return {
                valido: false,
                critico: true,
                mensaje: '❌ Error al validar capacidad del vehículo: ' + error.message
            };
        }
    },

    // ====================================
    // VALIDAR COMBUSTIBLE DISPONIBLE
    // ====================================
    async validarCombustible(vehiculoId, distanciaKm, supabase) {
        try {
            // Obtener último registro de gasoil
            const { data: ultimoCarga, error } = await supabase
                .from('tf_gasoil_consumo')
                .select('*')
                .eq('vehiculo_id', vehiculoId)
                .order('fecha', { ascending: false })
                .limit(1)
                .single();

            if (error && error.code !== 'PGRST116') throw error;

            // Si no hay registro, asumir tanque lleno
            let combustibleActual = this.CONFIG.CAPACIDAD_TANQUE;
            
            if (ultimoCarga) {
                // Calcular combustible estimado actual
                const kmRecorridos = ultimoCarga.kilometraje_actual; // desde última carga
                const galonesConsumidos = kmRecorridos / this.CONFIG.KM_POR_GALON;
                combustibleActual = ultimoCarga.galones - galonesConsumidos;
            }

            // Calcular combustible necesario para el viaje
            const galonesNecesarios = distanciaKm / this.CONFIG.KM_POR_GALON;
            const galonesConMargen = galonesNecesarios * (1 + this.CONFIG.MARGEN_SEGURIDAD_COMBUSTIBLE);

            if (combustibleActual < galonesConMargen) {
                const deficit = galonesConMargen - combustibleActual;
                return {
                    valido: false,
                    critico: combustibleActual < galonesNecesarios,
                    mensaje: combustibleActual < galonesNecesarios 
                        ? `❌ CRÍTICO: Combustible insuficiente. Actual: ${combustibleActual.toFixed(1)} gal, Necesario: ${galonesNecesarios.toFixed(1)} gal. Faltan ${deficit.toFixed(1)} galones.`
                        : `⚠️ ADVERTENCIA: Combustible justo. Se recomienda cargar ${deficit.toFixed(1)} galones adicionales para tener margen de seguridad.`,
                    combustibleActual: combustibleActual,
                    combustibleNecesario: galonesNecesarios,
                    deficit: deficit
                };
            }

            return {
                valido: true,
                mensaje: `✅ Combustible suficiente: ${combustibleActual.toFixed(1)} gal disponibles, ${galonesNecesarios.toFixed(1)} gal necesarios`,
                combustibleActual: combustibleActual,
                combustibleNecesario: galonesNecesarios,
                sobra: combustibleActual - galonesNecesarios
            };

        } catch (error) {
            console.error('Error validando combustible:', error);
            return {
                valido: false,
                critico: false,
                mensaje: '⚠️ No se pudo verificar el combustible: ' + error.message
            };
        }
    },

    // ====================================
    // CALCULAR PARADAS DE COMBUSTIBLE
    // ====================================
    async calcularParadasCombustible(distanciaKm, vehiculoId, supabase) {
        try {
            const autonomia = this.CONFIG.CAPACIDAD_TANQUE * this.CONFIG.KM_POR_GALON;
            
            // Si la distancia es menor que la autonomía, no necesita paradas
            if (distanciaKm <= autonomia * 0.8) { // 80% de seguridad
                return {
                    necesitaParadas: false,
                    numeroParadas: 0,
                    mensaje: `✅ No necesita paradas de combustible. Autonomía: ${autonomia.toFixed(0)} km, Distancia: ${distanciaKm} km`
                };
            }

            // Calcular número de paradas necesarias
            const numeroParadas = Math.ceil(distanciaKm / (autonomia * 0.8));
            const kmEntrePara das = distanciaKm / (numeroParadas + 1);
            
            // Calcular costo estimado
            const galonesTotal = distanciaKm / this.CONFIG.KM_POR_GALON;
            const costoEstimadoGalon = 2.00; // Precio promedio RD
            const costoTotal = galonesTotal * costoEstimadoGalon;

            return {
                necesitaParadas: true,
                numeroParadas: numeroParadas,
                kmEntreParadas: kmEntrePara das.toFixed(0),
                galonesTotales: galonesTotal.toFixed(1),
                costoEstimado: costoTotal.toFixed(2),
                mensaje: `⚠️ Se necesitan ${numeroParadas} parada(s) de combustible cada ${kmEntrePara das.toFixed(0)} km aproximadamente. Costo estimado: $${costoTotal.toFixed(2)}`
            };

        } catch (error) {
            console.error('Error calculando paradas de combustible:', error);
            return {
                necesitaParadas: false,
                numeroParadas: 0,
                mensaje: '⚠️ No se pudieron calcular las paradas de combustible'
            };
        }
    },

    // ====================================
    // FUNCIONES AUXILIARES
    // ====================================
    
    calcularHoraLlegada(horaSalida, duracionMinutos) {
        const [horas, minutos] = horaSalida.split(':').map(Number);
        const totalMinutos = horas * 60 + minutos + duracionMinutos;
        const nuevasHoras = Math.floor(totalMinutos / 60) % 24;
        const nuevosMinutos = totalMinutos % 60;
        return `${String(nuevasHoras).padStart(2, '0')}:${String(nuevosMinutos).padStart(2, '0')}`;
    },

    agregarMinutos(hora, minutos) {
        const [h, m] = hora.split(':').map(Number);
        const totalMin = h * 60 + m + minutos;
        const nuevaH = Math.floor(totalMin / 60) % 24;
        const nuevaM = totalMin % 60;
        return `${String(nuevaH).padStart(2, '0')}:${String(nuevaM).padStart(2, '0')}`;
    },

    hayConflictoHorario(inicio1, fin1, inicio2, fin2) {
        const i1 = this.horaAMinutos(inicio1);
        const f1 = this.horaAMinutos(fin1);
        const i2 = this.horaAMinutos(inicio2);
        const f2 = this.horaAMinutos(fin2);
        
        return (i1 < f2 && f1 > i2);
    },

    horaAMinutos(hora) {
        const [h, m] = hora.split(':').map(Number);
        return h * 60 + m;
    },

    async calcularHorasTrabajadas(choferId, fecha, supabase) {
        const { data, error } = await supabase
            .from('tf_asignaciones')
            .select(`
                hora_salida_real,
                hora_llegada_real,
                servicio:tf_servicios(hora_salida, hora_llegada_estimada),
                ruta:tf_rutas(duracion_estimada_minutos)
            `)
            .eq('chofer_id', choferId)
            .eq('servicio.fecha_servicio', fecha)
            .neq('estado', 'cancelado');

        if (error || !data) return 0;

        let totalMinutos = 0;
        for (const asig of data) {
            const duracion = asig.ruta?.duracion_estimada_minutos || 0;
            totalMinutos += duracion;
        }

        return totalMinutos / 60;
    },

    async obtenerUltimoServicio(choferId, fechaActual, supabase) {
        const { data, error } = await supabase
            .from('tf_asignaciones')
            .select(`
                *,
                servicio:tf_servicios(fecha_servicio, hora_llegada_estimada),
                ruta:tf_rutas(duracion_estimada_minutos)
            `)
            .eq('chofer_id', choferId)
            .lt('servicio.fecha_servicio', fechaActual)
            .eq('estado', 'completado')
            .order('servicio.fecha_servicio', { ascending: false })
            .limit(1)
            .single();

        if (error || !data) return null;

        return {
            fecha_fin: data.servicio.fecha_servicio,
            hora_fin: data.servicio.hora_llegada_estimada
        };
    },

    calcularHorasDescanso(fechaFin, horaFin, fechaInicio, horaInicio) {
        const fin = new Date(`${fechaFin}T${horaFin}`);
        const inicio = new Date(`${fechaInicio}T${horaInicio}`);
        const diff = inicio - fin;
        return diff / (1000 * 60 * 60); // Convertir a horas
    },

    async calcularDiasConsecutivos(choferId, fechaActual, supabase) {
        // Obtener servicios de los últimos 10 días
        const fechaInicio = new Date(fechaActual);
        fechaInicio.setDate(fechaInicio.getDate() - 10);

        const { data, error } = await supabase
            .from('tf_asignaciones')
            .select(`
                servicio:tf_servicios(fecha_servicio)
            `)
            .eq('chofer_id', choferId)
            .gte('servicio.fecha_servicio', fechaInicio.toISOString().split('T')[0])
            .lt('servicio.fecha_servicio', fechaActual)
            .neq('estado', 'cancelado')
            .order('servicio.fecha_servicio', { ascending: false });

        if (error || !data || data.length === 0) return 0;

        // Contar días consecutivos hacia atrás desde hoy
        let diasConsecutivos = 0;
        let fechaAnterior = new Date(fechaActual);
        fechaAnterior.setDate(fechaAnterior.getDate() - 1);

        const fechasTrabajadas = [...new Set(data.map(d => d.servicio.fecha_servicio))].sort().reverse();

        for (const fecha of fechasTrabajadas) {
            const fechaTrabajo = new Date(fecha);
            const diff = Math.abs(fechaAnterior - fechaTrabajo) / (1000 * 60 * 60 * 24);
            
            if (diff <= 1) {
                diasConsecutivos++;
                fechaAnterior = fechaTrabajo;
            } else {
                break;
            }
        }

        return diasConsecutivos;
    }
};

// Exportar para uso en el sistema
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ValidationModule;
}
