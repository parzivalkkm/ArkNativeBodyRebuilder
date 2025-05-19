class Tclass {
    value: number;
    t: Tclass;
    func() {
        sink(this.t);
    }
}
function source(): Tclass{
    return new Tclass();
}

function source1(s: Tclass){}

function sink(t: Tclass){}

function santization(s: Tclass){}

function T1() {
    let t = new Tclass();
    t.t = source();
    t.func();
}

function tiantIt(inn: Tclass, out: Tclass) {
    let x = out;
    x.t = inn;
    sink(x.t);
}


function T2() {
    let t1 = new Tclass(), t2 = new Tclass();
    tiantIt(source(), t1);
    sink(t1.t);
}

function loop() {
    let t = new Tclass();
    while(true) {
        sink(t1);
        t = source();
        let t1 = t
    }
}