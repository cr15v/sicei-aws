require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer');
const crypto = require('crypto');

// Clientes SDK de AWS
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const app = express();
app.use(express.json());
const PORT = 80;

// Configuración de subida de archivos en memoria
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Inicialización de conexiones a AWS
const awsConfig = {
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN
    }
};

const s3 = new S3Client(awsConfig);
const sns = new SNSClient(awsConfig);
const ddbClient = new DynamoDBClient(awsConfig);
const docClient = DynamoDBDocumentClient.from(ddbClient);

// Pool de conexiones a RDS MySQL
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10
});

// Validaciones del error 400
const esInvalido = (valor) => valor === undefined || valor === null || valor === '';
const methodNotAllowed = (req, res) => res.status(405).send();


// ---------------------------------- RUTAS DE ALUMNOS
app.route('/alumnos')
    .get(async (req, res) => {
        const [rows] = await db.query('SELECT * FROM alumnos');
        res.status(200).json(rows);
    })
    .post(async (req, res) => {
        const { nombres, apellidos, matricula, promedio, password } = req.body;

        // Validaciones de datos de entrada del alumno
        if (esInvalido(nombres) || esInvalido(apellidos) || esInvalido(matricula) || 
            typeof promedio !== 'number' || promedio < 0 || esInvalido(password)) {
            return res.status(400).json({ error: "Campos inválidos" });
        }

        const [result] = await db.query(
            'INSERT INTO alumnos (nombres, apellidos, matricula, promedio, password) VALUES (?, ?, ?, ?, ?)',
            [nombres, apellidos, matricula, promedio, password]
        );

        res.status(201).json({ id: result.insertId, nombres, apellidos, matricula, promedio, password, fotoPerfilUrl: null });
    })
    .delete(methodNotAllowed);

// CRUD de alumno por ID -----------------------
app.route('/alumnos/:id')
    .get(async (req, res) => {
        const [rows] = await db.query('SELECT * FROM alumnos WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: "Not Found" });
        res.status(200).json(rows[0]);
    })
    .put(async (req, res) => {
        const [rows] = await db.query('SELECT * FROM alumnos WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: "Not Found" });

        const { nombres, matricula } = req.body;
        if (esInvalido(nombres) || typeof matricula === 'number') return res.status(400).json({ error: "Bad Request" });

        await db.query('UPDATE alumnos SET nombres = ?, matricula = ? WHERE id = ?', [nombres, matricula, req.params.id]);
        const [updated] = await db.query('SELECT * FROM alumnos WHERE id = ?', [req.params.id]);
        res.status(200).json(updated[0]);
    })
    .delete(async (req, res) => {
        const [rows] = await db.query('SELECT * FROM alumnos WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: "Not Found" });

        await db.query('DELETE FROM alumnos WHERE id = ?', [req.params.id]);
        res.status(200).send();
    });

// Subir foto de perfil -------------------------------
app.post('/alumnos/:id/fotoPerfil', upload.single('foto'), async (req, res) => {
    const alumnoId = req.params.id;
    if (!req.file) return res.status(400).json({ error: "Falta el archivo de imagen" });

    const [rows] = await db.query('SELECT * FROM alumnos WHERE id = ?', [alumnoId]);
    if (rows.length === 0) return res.status(404).json({ error: "Not Found" });

    const alumno = rows[0];
    const s3Key = `perfil-${alumnoId}-${alumno.nombres.replace(/\s+/g, '')}-${req.file.originalname}`;

    try {
        const uploadParams = {
            Bucket: process.env.S3_BUCKET_NAME,
            Key: s3Key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype,
            ACL: 'public-read'
        };

        await s3.send(new PutObjectCommand(uploadParams));
        const fotoUrl = `https://${process.env.S3_BUCKET_NAME}.s3.amazonaws.com/${s3Key}`;

        // Persistir la URL pública en el registro RDS del alumno
        await db.query('UPDATE alumnos SET fotoPerfilUrl = ? WHERE id = ?', [fotoUrl, alumnoId]);

        res.status(200).json({ fotoPerfilUrl: fotoUrl });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Error al subir a S3" });
    }
});

// notificaciones SNS -----------------------
app.post('/alumnos/:id/email', async (req, res) => {
    const [rows] = await db.query('SELECT * FROM alumnos WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "Not Found" });

    const alumno = rows[0];
    const mensaje = `Información del Alumno:\nNombre: ${alumno.nombres} ${alumno.apellidos}\nMatrícula: ${alumno.matricula}\nPromedio: ${alumno.promedio}`;

    try {
        await sns.send(new PublishCommand({
            TopicArn: process.env.SNS_TOPIC_ARN,
            Message: mensaje,
            Subject: `Calificaciones de ${alumno.nombres}`
        }));
        res.status(200).json({ message: "Email enviado al topic de SNS exitosamente" });
    } catch (err) {
        res.status(500).json({ error: "Error de comunicación con SNS" });
    }
});

// Login -----------------------
app.post('/alumnos/:id/session/login', async (req, res) => {
    const { password } = req.body;
    const [rows] = await db.query('SELECT * FROM alumnos WHERE id = ?', [req.params.id]);
    
    if (rows.length === 0 || rows[0].password !== password) {
        return res.status(400).json({ error: "Credenciales inválidas" });
    }

    const sessionString = crypto.randomBytes(64).toString('hex'); 
    const sessionId = crypto.randomUUID();

    const item = {
        id: sessionId,
        fecha: Math.floor(Date.now() / 1000),
        alumnoId: parseInt(req.params.id),
        active: true,
        sessionString: sessionString
    };

    try {
        await docClient.send(new PutCommand({
            TableName: 'sesiones-alumnos',
            Item: item
        }));
        res.status(200).json({ sessionString });
    } catch (err) {
        res.status(500).json({ error: "Error al escribir en DynamoDB" });
    }
});

// Buscar una sesión activa
async function buscarSesion(sessionString, alumnoId) {
    const res = await docClient.send({
        middlewareStack: docClient.middlewareStack,
        send: async () => {},
        command: new PutCommand({}) 
    }).catch(() => null); 

    const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
    const scanRes = await docClient.send(new ScanCommand({
        TableName: 'sesiones-alumnos',
        FilterExpression: 'sessionString = :ss AND alumnoId = :aid',
        ExpressionAttributeValues: { ':ss': sessionString, ':aid': parseInt(alumnoId) }
    }));
    return scanRes.Items && scanRes.Items.length > 0 ? scanRes.Items[0] : null;
}

// Verify -----------------
app.post('/alumnos/:id/session/verify', async (req, res) => {
    const { sessionString } = req.body;
    try {
        const sesion = await buscarSesion(sessionString, req.params.id);
        if (sesion && sesion.active === true) {
            return res.status(200).json({ active: true });
        }
        res.status(400).json({ error: "Sesión no válida o expirada" });
    } catch (err) {
        res.status(400).json({ error: "Bad Request" });
    }
});

// Logout -----------------
app.post('/alumnos/:id/session/logout', async (req, res) => {
    const { sessionString } = req.body;
    try {
        const sesion = await buscarSesion(sessionString, req.params.id);
        if (!sesion) return res.status(400).json({ error: "Sesión no encontrada" });

        await docClient.send(new UpdateCommand({
            TableName: 'sesiones-alumnos',
            Key: { id: sesion.id },
            UpdateExpression: 'set active = :act',
            ExpressionAttributeValues: { ':act': false }
        }));
        res.status(200).json({ message: "Logout exitoso" });
    } catch (err) {
        res.status(400).json({ error: "Error" });
    }
});

// -------------------------------------------- RUTAS DE PROFESORES
app.route('/profesores')
    .get(async (req, res) => {
        const [rows] = await db.query('SELECT * FROM profesores');
        res.status(200).json(rows);
    })
    .post(async (req, res) => {
        const { nombres, apellidos, numeroEmpleado, horasClase } = req.body;
        if (esInvalido(nombres) || esInvalido(apellidos) || numeroEmpleado < 0 || typeof horasClase !== 'number' || horasClase < 0) {
            return res.status(400).json({ error: "Campos inválidos" });
        }
        const [result] = await db.query(
            'INSERT INTO profesores (nombres, apellidos, numeroEmpleado, horasClase) VALUES (?, ?, ?, ?)',
            [nombres, apellidos, numeroEmpleado, horasClase]
        );
        res.status(201).json({ id: result.insertId, nombres, apellidos, numeroEmpleado, horasClase });
    })
    .delete(methodNotAllowed);

// CRUD de profesor por ID -----------------------
app.route('/profesores/:id')
    .get(async (req, res) => {
        const [rows] = await db.query('SELECT * FROM profesores WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: "Not Found" });
        res.status(200).json(rows[0]);
    })
    .put(async (req, res) => {
        const { nombres, horasClase } = req.body;
        if (esInvalido(nombres) || typeof horasClase !== 'number' || horasClase < 0) return res.status(400).json({ error: "Bad Request" });

        await db.query('UPDATE profesores SET nombres = ?, horasClase = ? WHERE id = ?', [nombres, horasClase, req.params.id]);
        const [updated] = await db.query('SELECT * FROM profesores WHERE id = ?', [req.params.id]);
        res.status(200).json(updated[0]);
    })
    .delete(async (req, res) => {
        const [rows] = await db.query('SELECT * FROM profesores WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: "Not Found" });

        await db.query('DELETE FROM profesores WHERE id = ?', [req.params.id]);
        res.status(200).send();
    });

// -------------------------- MANEJO DE RUTAS NO EXISTENTES 
app.use((req, res) => {
    res.status(404).json({ error: "Ruta no encontrada" });
});

app.listen(PORT, () => {
    console.log(`SICEI API lista en puerto ${PORT}`);
});
