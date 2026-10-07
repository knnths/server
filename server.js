const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const QRCode = require("qrcode");
const ExcelJS = require("exceljs");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// ====================================================
// CONEXIÓN A LA BASE DE DATOS
// ====================================================
const conexion = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "inventario_db",
});

conexion.connect((err) => {
  if (err) {
    console.error("❌ Error conectando a la BD:", err);
  } else {
    console.log("✅ Conectado a MySQL");
  }
});

// ====================================================
// CARPETA DE QR (creación automática + servidor estático)
// ====================================================
const QR_DIR = path.join(__dirname, "qrs");
if (!fs.existsSync(QR_DIR)) {
  fs.mkdirSync(QR_DIR, { recursive: true });
  console.log("📁 Carpeta /qrs creada");
}
app.use("/qrs", express.static(QR_DIR));

// ====================================================
// LOGIN - SIN ENCRIPTACIÓN
// ====================================================
app.post("/login", (req, res) => {
  const { correo, password } = req.body;
  const sql = "SELECT * FROM usuarios WHERE usuario = ? AND clave = ?";

  conexion.query(sql, [correo, password], (err, result) => {
    if (err) {
      return res.json({ status: "error", mensaje: err.message });
    }
    if (result.length === 0) {
      return res.json({ status: "error", mensaje: "Usuario o contraseña incorrectos" });
    }

    const usuario = result[0];
    res.json({
      status: "ok",
      rol: usuario.rol,
      nombre: usuario.usuario,
    });
  });
});

// ====================================================
// MATERIALES - CRUD COMPLETO
// ====================================================

// Obtener todos los materiales
app.get("/materiales", (req, res) => {
  conexion.query("SELECT * FROM materiales ORDER BY id DESC", (err, result) => {
    if (err) {
      res.json({ status: "error", mensaje: err.message });
    } else {
      res.json(result);
    }
  });
});

// Registrar nuevo material
app.post("/materiales", (req, res) => {
  const { nombre, cantidad, estado } = req.body;
  const sql = "INSERT INTO materiales (nombre, cantidad, estado) VALUES (?, ?, ?)";

  conexion.query(sql, [nombre, cantidad, estado], (err, result) => {
    if (err) {
      res.json({ status: "error", mensaje: err.message });
    } else {
      res.json({ status: "ok", mensaje: "Material registrado", id: result.insertId });
    }
  });
});

// Editar material
app.put("/materiales/:id", (req, res) => {
  const { nombre, cantidad, estado } = req.body;
  const sql = "UPDATE materiales SET nombre = ?, cantidad = ?, estado = ? WHERE id = ?";

  conexion.query(sql, [nombre, cantidad, estado, req.params.id], (err, result) => {
    if (err) {
      res.json({ status: "error", mensaje: err.message });
    } else {
      res.json({ status: "ok", mensaje: "Material actualizado" });
    }
  });
});

// Eliminar material
app.delete("/materiales/:id", (req, res) => {
  conexion.query("DELETE FROM materiales WHERE id = ?", [req.params.id], (err, result) => {
    if (err) {
      res.json({ status: "error", mensaje: err.message });
    } else {
      res.json({ status: "ok", mensaje: "Material eliminado" });
    }
  });
});

// ====================================================
// PERMISOS - CRUD COMPLETO
// ====================================================

// Asignar o actualizar permiso
app.post("/permisos", (req, res) => {
  const { maestro, material_id, puede_ver, puede_prestar, puede_devolver } = req.body;

  const sql = `
    INSERT INTO permisos (maestro, material_id, puede_ver, puede_prestar, puede_devolver) 
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE 
    puede_ver = VALUES(puede_ver), 
    puede_prestar = VALUES(puede_prestar), 
    puede_devolver = VALUES(puede_devolver)
  `;

  conexion.query(sql, [maestro, material_id, puede_ver, puede_prestar, puede_devolver], (err, result) => {
    if (err) {
      res.json({ status: "error", mensaje: err.message });
    } else {
      res.json({ status: "ok", mensaje: "Permiso asignado" });
    }
  });
});

// Obtener permisos de un maestro
app.get("/permisos/:maestro", (req, res) => {
  const sql = `
    SELECT p.*, m.nombre AS material 
    FROM permisos p 
    JOIN materiales m ON p.material_id = m.id 
    WHERE p.maestro = ?
  `;
  conexion.query(sql, [req.params.maestro], (err, result) => {
    if (err) {
      res.json({ status: "error", mensaje: err.message });
    } else {
      res.json(result);
    }
  });
});

// Eliminar permiso
app.delete("/permisos", (req, res) => {
  const { maestro, material_id } = req.body;
  conexion.query(
    "DELETE FROM permisos WHERE maestro = ? AND material_id = ?",
    [maestro, material_id],
    (err, result) => {
      if (err) {
        res.json({ status: "error", mensaje: err.message });
      } else {
        res.json({ status: "ok", mensaje: "Permiso eliminado" });
      }
    }
  );
});

// ====================================================
// PRÉSTAMOS Y DEVOLUCIONES
// ====================================================

// Escaneo QR con modo opcional (prestar / devolver / automático)
app.post("/prestamos/escanear_qr", (req, res) => {
  const { material_id, maestro, modo } = req.body;

  // Si viene modo explícito, respetarlo; si no, comportamiento automático
  const modoForzado = modo === "prestar" || modo === "devolver" ? modo : null;

  // Buscar préstamo activo de ese material
  conexion.query(
    "SELECT * FROM prestamos WHERE material_id = ? AND fecha_devolucion IS NULL LIMIT 1",
    [material_id],
    (err, activos) => {
      if (err) return res.json({ status: "error", mensaje: err.message });

      const hayActivo = activos.length > 0;

      // === CASO: DEVOLVER ===
      if (modoForzado === "devolver" || (!modoForzado && hayActivo)) {
        if (!hayActivo) {
          return res.json({
            status: "fail",
            mensaje: "⛔ No hay préstamo activo para devolver",
          });
        }
        conexion.query(
          "UPDATE prestamos SET fecha_devolucion = NOW() WHERE id = ?",
          [activos[0].id],
          (err2) => {
            if (err2) return res.json({ status: "error", mensaje: err2.message });
            return res.json({
              status: "ok",
              accion: "devolucion",
              mensaje: "✅ Material devuelto",
            });
          }
        );
        return;
      }

      // === CASO: PRESTAR ===
      if (modoForzado === "prestar" || (!modoForzado && !hayActivo)) {
        if (hayActivo) {
          return res.json({
            status: "fail",
            mensaje: "⛔ Este material ya está prestado. Devuélvelo primero.",
          });
        }

        conexion.query(
          "SELECT * FROM permisos WHERE maestro = ? AND material_id = ? AND puede_prestar = TRUE",
          [maestro, material_id],
          (err2, permisos) => {
            if (err2) return res.json({ status: "error", mensaje: err2.message });
            if (permisos.length === 0) {
              return res.json({
                status: "fail",
                mensaje: "⛔ No tienes permiso para prestar",
              });
            }

            conexion.query(
              "INSERT INTO prestamos (material_id, fecha_prestamo, maestro) VALUES (?, NOW(), ?)",
              [material_id, maestro],
              (err3) => {
                if (err3) return res.json({ status: "error", mensaje: err3.message });
                return res.json({
                  status: "ok",
                  accion: "prestamo",
                  mensaje: "✅ Préstamo registrado",
                });
              }
            );
          }
        );
      }
    }
  );
});

// Préstamo manual
app.post("/prestamos", (req, res) => {
  const { material_id, fecha_prestamo, maestro } = req.body;

  conexion.query(
    "SELECT * FROM permisos WHERE maestro = ? AND material_id = ? AND puede_prestar = TRUE",
    [maestro, material_id],
    (err, result) => {
      if (err) return res.json({ status: "error", mensaje: err.message });
      if (result.length === 0) {
        return res.json({ status: "fail", mensaje: "⛔ Sin permiso para prestar" });
      }

      conexion.query(
        "INSERT INTO prestamos (material_id, fecha_prestamo, maestro) VALUES (?, ?, ?)",
        [material_id, fecha_prestamo || new Date(), maestro],
        (err2) => {
          if (err2) return res.json({ status: "error", mensaje: err2.message });
          res.json({ status: "ok", mensaje: "✅ Préstamo registrado" });
        }
      );
    }
  );
});

// Obtener todos los préstamos
app.get("/prestamos", (req, res) => {
  const sql = `
    SELECT p.id, p.material_id, p.fecha_prestamo, p.fecha_devolucion, p.maestro, m.nombre AS material
    FROM prestamos p
    LEFT JOIN materiales m ON p.material_id = m.id
    ORDER BY p.id DESC
  `;
  conexion.query(sql, (err, result) => {
    if (err) {
      res.json({ status: "error", mensaje: err.message });
    } else {
      res.json(result);
    }
  });
});

// Devolver por ID de préstamo
app.put("/prestamos/devolver_id/:id", (req, res) => {
  conexion.query(
    "UPDATE prestamos SET fecha_devolucion = NOW() WHERE id = ?",
    [req.params.id],
    (err) => {
      if (err) return res.json({ status: "error", mensaje: err.message });
      res.json({ status: "ok", mensaje: "✅ Devuelto" });
    }
  );
});

// Actualizar fecha de devolución manual
app.put("/prestamos/:id", (req, res) => {
  const { fecha_devolucion } = req.body;
  conexion.query(
    "UPDATE prestamos SET fecha_devolucion = ? WHERE id = ?",
    [fecha_devolucion, req.params.id],
    (err) => {
      if (err) return res.json({ status: "error", mensaje: err.message });
      res.json({ status: "ok", mensaje: "✅ Fecha actualizada" });
    }
  );
});

// ====================================================
// NOTIFICACIONES
// ====================================================
app.get("/notificaciones/:maestro", (req, res) => {
  const sql = `
    SELECT p.id, p.material_id, p.fecha_prestamo, m.nombre AS material
    FROM prestamos p
    JOIN materiales m ON p.material_id = m.id
    WHERE p.maestro = ? AND p.fecha_devolucion IS NULL
  `;
  conexion.query(sql, [req.params.maestro], (err, result) => {
    if (err) {
      res.json({ status: "error", mensaje: err.message });
    } else {
      res.json(result);
    }
  });
});

// ====================================================
// REPORTES Y ESTADÍSTICAS
// ====================================================

// Total de préstamos
app.get("/reportes/total", (req, res) => {
  conexion.query("SELECT COUNT(*) AS total FROM prestamos", (err, result) => {
    if (err) return res.json({ status: "error", mensaje: err.message });
    res.json({ total: result[0].total });
  });
});

// Préstamos pendientes
app.get("/reportes/pendientes", (req, res) => {
  conexion.query(
    "SELECT COUNT(*) AS pendientes FROM prestamos WHERE fecha_devolucion IS NULL",
    (err, result) => {
      if (err) return res.json({ status: "error", mensaje: err.message });
      res.json({ pendientes: result[0].pendientes });
    }
  );
});

// Préstamos devueltos
app.get("/reportes/devueltos", (req, res) => {
  conexion.query(
    "SELECT COUNT(*) AS devueltos FROM prestamos WHERE fecha_devolucion IS NOT NULL",
    (err, result) => {
      if (err) return res.json({ status: "error", mensaje: err.message });
      res.json({ devueltos: result[0].devueltos });
    }
  );
});

// Reportes filtrados por maestro y fechas
app.get("/reportes/filtrados", (req, res) => {
  const { maestro, fecha_inicio, fecha_fin } = req.query;

  let sql = `
    SELECT p.id, p.maestro, p.fecha_prestamo, p.fecha_devolucion, m.nombre AS material 
    FROM prestamos p 
    LEFT JOIN materiales m ON p.material_id = m.id 
    WHERE 1=1
  `;
  const params = [];

  if (maestro && maestro.trim() !== "") {
    sql += " AND p.maestro LIKE ?";
    params.push(`%${maestro}%`);
  }
  if (fecha_inicio && fecha_inicio.trim() !== "") {
    sql += " AND p.fecha_prestamo >= ?";
    params.push(fecha_inicio);
  }
  if (fecha_fin && fecha_fin.trim() !== "") {
    sql += " AND p.fecha_prestamo <= ?";
    params.push(fecha_fin);
  }

  sql += " ORDER BY p.id DESC";

  conexion.query(sql, params, (err, result) => {
    if (err) return res.status(500).json({ status: "error", mensaje: err.message });
    res.json(result);
  });
});

// ====================================================
// EXPORTAR REPORTES
// ====================================================

// Exportar a PDF
app.get("/reportes/pdf", (req, res) => {
  const { maestro, fecha_inicio, fecha_fin } = req.query;

  let sql = `
    SELECT p.id, p.maestro, p.fecha_prestamo, p.fecha_devolucion, m.nombre AS material 
    FROM prestamos p 
    LEFT JOIN materiales m ON p.material_id = m.id 
    WHERE 1=1
  `;
  const params = [];

  if (maestro && maestro.trim() !== "") {
    sql += " AND p.maestro LIKE ?";
    params.push(`%${maestro}%`);
  }
  if (fecha_inicio && fecha_inicio.trim() !== "") {
    sql += " AND p.fecha_prestamo >= ?";
    params.push(fecha_inicio);
  }
  if (fecha_fin && fecha_fin.trim() !== "") {
    sql += " AND p.fecha_prestamo <= ?";
    params.push(fecha_fin);
  }

  conexion.query(sql, params, (err, result) => {
    if (err) return res.status(500).send("Error en la consulta");

    let contenido = `=========================================\n`;
    contenido += `   REPORTE DE INVENTARIO ESCOLAR\n`;
    contenido += `=========================================\n\n`;
    contenido += `Fecha: ${new Date().toLocaleString()}\n\n`;

    result.forEach((row) => {
      contenido += `ID: ${row.id} | Material: ${row.material || 'N/A'}\n`;
      contenido += `Maestro: ${row.maestro}\n`;
      contenido += `Fecha Préstamo: ${row.fecha_prestamo}\n`;
      contenido += `Estado: ${row.fecha_devolucion ? '✅ Devuelto' : '⏳ Pendiente'}\n`;
      contenido += `-----------------------------------------\n`;
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=reporte.pdf");
    res.send(Buffer.from(contenido));
  });
});

// Exportar a Excel
app.get("/reportes/excel", async (req, res) => {
  const { maestro, fecha_inicio, fecha_fin } = req.query;

  let sql = `
    SELECT p.id, p.maestro, p.fecha_prestamo, p.fecha_devolucion, m.nombre AS material 
    FROM prestamos p 
    LEFT JOIN materiales m ON p.material_id = m.id 
    WHERE 1=1
  `;
  const params = [];

  if (maestro && maestro.trim() !== "") {
    sql += " AND p.maestro LIKE ?";
    params.push(`%${maestro}%`);
  }
  if (fecha_inicio && fecha_inicio.trim() !== "") {
    sql += " AND p.fecha_prestamo >= ?";
    params.push(fecha_inicio);
  }
  if (fecha_fin && fecha_fin.trim() !== "") {
    sql += " AND p.fecha_prestamo <= ?";
    params.push(fecha_fin);
  }

  conexion.query(sql, params, async (err, result) => {
    if (err) return res.status(500).send("Error en la consulta");

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Reporte");

    worksheet.columns = [
      { header: "ID", key: "id", width: 10 },
      { header: "Material", key: "material", width: 30 },
      { header: "Maestro", key: "maestro", width: 25 },
      { header: "Fecha Préstamo", key: "fecha_prestamo", width: 25 },
      { header: "Estado", key: "estado", width: 15 },
    ];

    result.forEach((row) => {
      worksheet.addRow({
        id: row.id,
        material: row.material || "N/A",
        maestro: row.maestro,
        fecha_prestamo: row.fecha_prestamo,
        estado: row.fecha_devolucion ? "Devuelto" : "Pendiente",
      });
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=reporte.xlsx");
    await workbook.xlsx.write(res);
    res.end();
  });
});

// ====================================================
// GENERAR QR (ahora guarda PNG en /qrs)
// ====================================================
app.get("/generar_qr/:material_id", async (req, res) => {
  const id = req.params.material_id;

  // Validar que exista el material (opcional pero recomendado)
  conexion.query(
    "SELECT nombre FROM materiales WHERE id = ?",
    [id],
    async (err, rows) => {
      if (err) {
        return res.json({ status: "error", mensaje: err.message });
      }
      if (rows.length === 0) {
        return res.json({ status: "error", mensaje: "Material no encontrado" });
      }

      const nombre = rows[0].nombre;
      const fileName = `qr_${id}.png`;
      const filePath = path.join(QR_DIR, fileName);

      try {
        // El QR contiene SOLO el ID (como texto plano)
        await QRCode.toFile(filePath, String(id), {
          width: 500,
          margin: 2,
          color: {
            dark: "#000000",
            light: "#FFFFFF",
          },
        });

        res.json({
          status: "ok",
          qr_url: `http://192.168.1.136:3000/qrs/${fileName}`,
          qr_base64: await QRCode.toDataURL(String(id)), // por si lo quieres mostrar directo
          material_id: id,
          material_nombre: nombre,
        });
      } catch (e) {
        res.json({ status: "error", mensaje: e.message });
      }
    }
  );
});

// ====================================================
// LISTAR QRs GENERADOS
// ====================================================
app.get("/qrs/lista", (req, res) => {
  fs.readdir(QR_DIR, (err, files) => {
    if (err) return res.json({ status: "error", mensaje: err.message });
    const qrs = files
      .filter((f) => f.endsWith(".png"))
      .map((f) => ({
        archivo: f,
        url: `http://192.168.1.136:3000/qrs/${f}`,
      }));
    res.json(qrs);
  });
});

// ====================================================
// INICIAR SERVIDOR
// ====================================================
const PORT = 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor en http://192.168.1.136:${PORT}`);
  console.log(`📱 Celular: http://192.168.1.136:${PORT}`);
  console.log(`📁 QRs en: http://192.168.1.136:${PORT}/qrs/`);
  console.log(`🔑 admin/1234 | juan/abcd`);
});