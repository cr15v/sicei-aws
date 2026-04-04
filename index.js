const express = require('express');
const app = express();
app.use(express.json());
const PORT = 80;

let alumnos = [];
let profesores = [];

const esInvalido = (valor) => valor === undefined || valor === null || valor === '';
const methodNotAllowed = (req, res) => res.status(405).send();

// --------------------- RUTAS DE ALUMNOS

app.route('/alumnos')
    .get((req, res) => {
        res.status(200).json(alumnos);
    })
    .post((req, res) => {
        const { id, nombres, apellidos, matricula, promedio } = req.body;

        if (esInvalido(id) || typeof id !== 'number' || id <= 0 ||
            esInvalido(nombres) || esInvalido(apellidos) || 
            esInvalido(matricula) || typeof promedio !== 'number' || promedio < 0) {
            return res.status(400).json({ error: "Campos inválidos" });
        }

        const nuevo = { id, nombres, apellidos, matricula, promedio };
        alumnos.push(nuevo);
        res.status(201).json(nuevo);
    })
    .delete(methodNotAllowed);

app.route('/alumnos/:id')
    .get((req, res) => {
        const item = alumnos.find(a => a.id === parseInt(req.params.id));
        item ? res.json(item) : res.status(404).json({ error: "Not found" });
    })
    .put((req, res) => {
        const idParam = parseInt(req.params.id);
        const index = alumnos.findIndex(a => a.id === idParam);
        if (index === -1) return res.status(404).json({ error: "Not found" });

        const { nombres, matricula } = req.body;
        // Validación de campos incorrectos (testPutAlumnoWithWrongFields)
        if (esInvalido(nombres) || typeof matricula === 'number') {
            return res.status(400).json({ error: "Bad request" });
        }

        alumnos[index] = { ...alumnos[index], ...req.body };
        res.status(200).json(alumnos[index]);
    })
    .delete((req, res) => {
        const idParam = parseInt(req.params.id);
        const index = alumnos.findIndex(a => a.id === idParam);
        if (index === -1) return res.status(404).json({ error: "Not found" });
        
        alumnos.splice(index, 1);
        res.status(200).send();
    });

// ------------------------------ RUTAS DE PROFESORES

app.route('/profesores')
    .get((req, res) => {
        res.status(200).json(profesores);
    })
    .post((req, res) => {
        const { id, numeroEmpleado, nombres, apellidos, horasClase } = req.body;

        if (esInvalido(id) || id <= 0 || esInvalido(nombres) || 
            esInvalido(apellidos) || esInvalido(numeroEmpleado) || 
            numeroEmpleado < 0 || typeof horasClase !== 'number' || horasClase < 0) {
            return res.status(400).json({ error: "Campos inválidos" });
        }

        const nuevo = { id, numeroEmpleado, nombres, apellidos, horasClase };
        profesores.push(nuevo);
        res.status(201).json(nuevo);
    })
    .delete(methodNotAllowed);

app.route('/profesores/:id')
    .get((req, res) => {
        const item = profesores.find(p => p.id === parseInt(req.params.id));
        item ? res.json(item) : res.status(404).json({ error: "Not found" });
    })
    .put((req, res) => {
        const idParam = parseInt(req.params.id);
        const index = profesores.findIndex(p => p.id === idParam);
        if (index === -1) return res.status(404).json({ error: "Not found" });

        const { nombres, horasClase } = req.body;
        if (esInvalido(nombres) || typeof horasClase !== 'number' || horasClase < 0) {
            return res.status(400).json({ error: "Bad request" });
        }

        profesores[index] = { ...profesores[index], ...req.body };
        res.status(200).json(profesores[index]);
    })
    .delete((req, res) => {
        const idParam = parseInt(req.params.id);
        const index = profesores.findIndex(p => p.id === idParam);
        if (index === -1) return res.status(404).json({ error: "Not found" });
        
        profesores.splice(index, 1);
        res.status(200).send();
    });

// -------------------------- MANEJO DE RUTAS NO EXISTENTES 
app.use((req, res) => {
    res.status(404).json({ error: "Ruta no encontrada" });
});

app.listen(PORT, () => {
    console.log(`SICEI API lista en puerto ${PORT}`);
});