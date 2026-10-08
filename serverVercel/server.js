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
// URL PÚBLICA (Vercel la asigna, o la defines en env)
// ====================================================
const PUBLIC_URL =
  process.env.PUBLIC_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

// ====================================================
// POOL DE CONEXIONES (máx 5 en Clever Cloud)
// ====================================================
const pool = mysql.createPool({
  host: process.env.DB_HOST || "bavbb5mqjviwtzsinddy-mysql.services.clever-cloud.com",
  user: process.env.DB_USER || "u7f2pupwf4h2zhlr",
  password: process.env.DB_PASSWORD || "qtWvJosXfF7BkpkZU17f",
  database: process.env.DB_NAME || "bavbb5mqjviwtzsinddy",
  waitForConnections: true,
  connectionLimit: 5,       // 👈 límite duro de Clever Cloud
  maxIdle: 5,
  idleTimeout: 60000,       // 60s
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

// Probar conexión al arrancar (solo log, no bloquea)
pool.getConnection((err, conn) => {
  if (err) {
    console.error("❌ Error conectando al pool:", err.message);
  } else {
    console.log("✅ Pool MySQL listo (límite 5 conexiones)");
    conn.release();
  }
});

// ====================================================
// CARPETA DE QR — en Vercel es read-only salvo /tmp
// ====================================================
const QR_DIR = path.join("/tmp", "qrs");
if (!fs.existsSync(QR_DIR)) {
  fs.mkdirSync(QR_DIR, { recursive: true });
}
// En Vercel NO se pueden servir archivos estáticos persistentes desde /tmp.
// Igual exponemos la ruta por si en local funciona.
app.use("/qrs", express.static(QR_DIR));

// ====================================================
// LOGIN
// ====================================================
app.post("/login", (req, res) => {
  const { nombre, password } = req.body;
  const sql = "SELECT * FROM usuarios WHERE nombre = ? AND password = ?";
  pool.query(sql, [nombre, password], (err, result) => {
    if (err) return res.json({ status: "error", mensaje: err.message });
    if (result.length === 0)
      return res.json({ status: "error", mensaje: "Usuario o contraseña incorrectos" });

    const usuario = result[0];
    res.json({ status: "ok", rol: usuario.rol, nombre: usuario.nombre });
  });
});

// ====================================================
// MATERIALES - CRUD
// ====================================================
app.get("/materiales", (req, res) => {
  pool.query("SELECT * FROM materiales ORDER BY id DESC", (err, result) => {
    if (err) return res.json({ status: "error", mensaje: err.message });
    res.json(result);
  });
});

app.post("/materiales", (req, res) => {
  const { nombre, cantidad, estado } = req.body;
  pool.query(
    "INSERT INTO materiales (nombre, cantidad, estado) VALUES (?, ?, ?)",
    [nombre, cantidad, estado],
    (err, result) => {
      if (err) return res.json({ status: "error", mensaje: err.message });
      res.json({ status: "ok", mensaje: "Material registrado", id: result.insertId });
    }
  );
});

app.put("/materiales/:id", (req, res) => {
  const { nombre, cantidad, estado } = req.body;
  pool.query(
    "UPDATE materiales SET nombre = ?, cantidad = ?, estado = ? WHERE id = ?",
    [nombre, cantidad, estado, req.params.id],
    (err) => {
      if (err) return res.json({ status: "error", mensaje: err.message });
      res.json({ status: "ok", mensaje: "Material actualizado" });
    }
  );
});

app.delete("/materiales/:id", (req, res) => {
  pool.query("DELETE FROM materiales WHERE id = ?", [req.params.id], (err) => {
    if (err) return res.json({ status: "error", mensaje: err.message });
    res.json({ status: "ok", mensaje: "Material eliminado" });
  });
});

// ====================================================
// PERMISOS
// ====================================================
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
  pool.query(
    sql,
    [maestro, material_id, puede_ver, puede_prestar, puede_devolver],
    (err) => {
      if (err) return res.json({ status: "error", mensaje: err.message });
      res.json({ status: "ok", mensaje: "Permiso asignado" });
    }
  );
});

app.get("/permisos/:maestro", (req, res) => {
  const sql = `
    SELECT p.*, m.nombre AS material
    FROM permisos p
    JOIN materiales m ON p.material_id = m.id
    WHERE p.maestro = ?
  `;
  pool.query(sql, [req.params.maestro], (err, result) => {
    if (err) return res.json({ status: "error", mensaje: err.message });
    res.json(result);
  });
});

app.delete("/permisos", (req, res) => {
  const { maestro, material_id } = req.body;
  pool.query(
    "DELETE FROM permisos WHERE maestro = ? AND material_id = ?",
    [maestro, material_id],
    (err) => {
      if (err) return res.json({ status: "error", mensaje: err.message });
      res.json({ status: "ok", mensaje: "Permiso eliminado" });
    }
  );
});

// ====================================================
// PRÉSTAMOS
// ====================================================
app.post("/prestamos/escanear_qr", (req, res) => {
  const { material_id, maestro, modo } = req.body;
  const modoForzado = modo === "prestar" || modo === "devolver" ? modo : null;

  pool.query(
    "SELECT * FROM prestamos WHERE material_id = ? AND fecha_devolucion IS NULL LIMIT 1",
    [material_id],
    (err, activos) => {
      if (err) return res.json({ status: "error", mensaje: err.message });
      const hayActivo = activos.length > 0;

      // DEVOLVER
      if (modoForzado === "devolver" || (!modoForzado && hayActivo)) {
        if (!hayActivo)
          return res.json({ status: "fail", mensaje: "⛔ No hay préstamo activo para devolver" });

        return pool.query(
          "UPDATE prestamos SET fecha_devolucion = NOW() WHERE id = ?",
          [activos[0].id],
          (err2) => {
            if (err2) return res.json({ status: "error", mensaje: err2.message });
            res.json({ status: "ok", accion: "devolucion", mensaje: "✅ Material devuelto" });
          }
        );
      }

      // PRESTAR
      if (modoForzado === "prestar" || (!modoForzado && !hayActivo)) {
        if (hayActivo)
          return res.json({ status: "fail", mensaje: "⛔ Este material ya está prestado." });

        pool.query(
          "SELECT * FROM permisos WHERE maestro = ? AND material_id = ? AND puede_prestar = TRUE",
          [maestro, material_id],
          (err2, permisos) => {
            if (err2) return res.json({ status: "error", mensaje: err2.message });
            if (permisos.length === 0)
              return res.json({ status: "fail", mensaje: "⛔ No tienes permiso para prestar" });

            pool.query(
              "INSERT INTO prestamos (material_id, fecha_prestamo, maestro) VALUES (?, NOW(), ?)",
              [material_id, maestro],
              (err3) => {
                if (err3) return res.json({ status: "error", mensaje: err3.message });
                res.json({ status: "ok", accion: "prestamo", mensaje: "✅ Préstamo registrado" });
              }
            );
          }
        );
      }
    }
  );
});

app.post("/prestamos", (req, res) => {
  const { material_id, fecha_prestamo, maestro } = req.body;
  pool.query(
    "SELECT * FROM permisos WHERE maestro = ? AND material_id = ? AND puede_prestar = TRUE",
    [maestro, material_id],
    (err, result) => {
      if (err) return res.json({ status: "error", mensaje: err.message });
      if (result.length === 0)
        return res.json({ status: "fail", mensaje: "⛔ Sin permiso para prestar" });

      pool.query(
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

app.get("/prestamos", (req, res) => {
  const sql = `
    SELECT p.id, p.material_id, p.fecha_prestamo, p.fecha_devolucion, p.maestro, m.nombre AS material
    FROM prestamos p
    LEFT JOIN materiales m ON p.material_id = m.id
    ORDER BY p.id DESC
  `;
  pool.query(sql, (err, result) => {
    if (err) return res.json({ status: "error", mensaje: err.message });
    res.json(result);
  });
});

app.put("/prestamos/devolver_id/:id", (req, res) => {
  pool.query(
    "UPDATE prestamos SET fecha_devolucion = NOW() WHERE id = ?",
    [req.params.id],
    (err) => {
      if (err) return res.json({ status: "error", mensaje: err.message });
      res.json({ status: "ok", mensaje: "✅ Devuelto" });
    }
  );
});

app.put("/prestamos/:id", (req, res) => {
  const { fecha_devolucion } = req.body;
  pool.query(
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
  pool.query(sql, [req.params.maestro], (err, result) => {
    if (err) return res.json({ status: "error", mensaje: err.message });
    res.json(result);
  });
});

// ====================================================
// REPORTES
// ====================================================
app.get("/reportes/total", (req, res) => {
  pool.query("SELECT COUNT(*) AS total FROM prestamos", (err, result) => {
    if (err) return res.json({ status: "error", mensaje: err.message });
    res.json({ total: result[0].total });
  });
});

app.get("/reportes/pendientes", (req, res) => {
  pool.query(
    "SELECT COUNT(*) AS pendientes FROM prestamos WHERE fecha_devolucion IS NULL",
    (err, result) => {
      if (err) return res.json({ status: "error", mensaje: err.message });
      res.json({ pendientes: result[0].pendientes });
    }
  );
});

app.get("/reportes/devueltos", (req, res) => {
  pool.query(
    "SELECT COUNT(*) AS devueltos FROM prestamos WHERE fecha_devolucion IS NOT NULL",
    (err, result) => {
      if (err) return res.json({ status: "error", mensaje: err.message });
      res.json({ devueltos: result[0].devueltos });
    }
  );
});

function buildFiltro(query) {
  const { maestro, fecha_inicio, fecha_fin } = query;
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
  return { sql, params };
}

app.get("/reportes/filtrados", (req, res) => {
  const { sql, params } = buildFiltro(req.query);
  pool.query(sql, params, (err, result) => {
    if (err) return res.status(500).json({ status: "error", mensaje: err.message });
    res.json(result);
  });
});

app.get("/reportes/pdf", (req, res) => {
  const { sql, params } = buildFiltro(req.query);
  pool.query(sql, params, (err, result) => {
    if (err) return res.status(500).send("Error en la consulta");

    let contenido = `=========================================\n`;
    contenido += `   REPORTE DE INVENTARIO ESCOLAR\n`;
    contenido += `=========================================\n\n`;
    contenido += `Fecha: ${new Date().toLocaleString()}\n\n`;

    result.forEach((row) => {
      contenido += `ID: ${row.id} | Material: ${row.material || "N/A"}\n`;
      contenido += `Maestro: ${row.maestro}\n`;
      contenido += `Fecha Préstamo: ${row.fecha_prestamo}\n`;
      contenido += `Estado: ${row.fecha_devolucion ? "✅ Devuelto" : "⏳ Pendiente"}\n`;
      contenido += `-----------------------------------------\n`;
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=reporte.pdf");
    res.send(Buffer.from(contenido));
  });
});

app.get("/reportes/excel", (req, res) => {
  const { sql, params } = buildFiltro(req.query);
  pool.query(sql, params, async (err, result) => {
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

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", "attachment; filename=reporte.xlsx");
    await workbook.xlsx.write(res);
    res.end();
  });
});

// ====================================================
// GENERAR QR — se devuelve también base64 (Vercel no persiste /tmp)
// ====================================================
app.get("/generar_qr/:material_id", (req, res) => {
  const id = req.params.material_id;
  pool.query(
    "SELECT nombre FROM materiales WHERE id = ?",
    [id],
    async (err, rows) => {
      if (err) return res.json({ status: "error", mensaje: err.message });
      if (rows.length === 0)
        return res.json({ status: "error", mensaje: "Material no encontrado" });

      const nombre = rows[0].nombre;
      const fileName = `qr_${id}.png`;
      const filePath = path.join(QR_DIR, fileName);

      try {
        await QRCode.toFile(filePath, String(id), {
          width: 500,
          margin: 2,
          color: { dark: "#000000", light: "#FFFFFF" },
        });

        res.json({
          status: "ok",
          qr_url: `${PUBLIC_URL}/qrs/${fileName}`, // puede no persistir en Vercel
          qr_base64: await QRCode.toDataURL(String(id)), // 👈 úsalo en el frontend
          material_id: id,
          material_nombre: nombre,
        });
      } catch (e) {
        res.json({ status: "error", mensaje: e.message });
      }
    }
  );
});

app.get("/qrs/lista", (req, res) => {
  fs.readdir(QR_DIR, (err, files) => {
    if (err) return res.json({ status: "error", mensaje: err.message });
    const qrs = files
      .filter((f) => f.endsWith(".png"))
      .map((f) => ({ archivo: f, url: `${PUBLIC_URL}/qrs/${f}` }));
    res.json(qrs);
  });
});

// ====================================================
// HEALTHCHECK (útil para Vercel)
// ====================================================
app.get("/", (req, res) => {
  res.json({ status: "ok", servicio: "Inventario Escolar API", url: PUBLIC_URL });
});

// ====================================================
// EXPORT para Vercel (NO usar app.listen aquí)
// ====================================================
module.exports = app;